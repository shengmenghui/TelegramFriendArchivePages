"use strict";
import { Reader } from './reader.js';

const reader = new Reader();
reader.onFatal = message => lockPage(message);
reader.onProgress = message => {
  if (!unlocked && document.querySelector('#unlockButton').disabled) document.querySelector('#unlockStatus').textContent = message;
};
let unlocked = false, lastActivity = Date.now(), viewGeneration = 0, imageGeneration = 0;
const blobURLs = new Set();
let imageURL = null;

const state = {
  meta: null,
  timezone: "china",
  mode: "timeline",
  items: [],
  oldestRowId: null,
  newestRowId: null,
  hasOlder: false,
  hasNewer: false,
  contextConversation: null,
  searchOffset: 0,
  searchHasMore: false,
  searchQuery: "",
  focusRecordId: null,
  indexedAt: null,
  pollBusy: false,
};

const elements = {
  archiveSummary: document.querySelector("#archiveSummary"),
  sidebar: document.querySelector("#sidebar"),
  filterToggle: document.querySelector("#filterToggle"),
  searchForm: document.querySelector("#searchForm"),
  searchInput: document.querySelector("#searchInput"),
  platform: document.querySelector("#platformFilter"),
  sender: document.querySelector("#senderFilter"),
  conversation: document.querySelector("#conversationFilter"),
  topic: document.querySelector("#topicFilter"),
  deleted: document.querySelector("#deletedFilter"),
  media: document.querySelector("#mediaFilter"),
  dateFrom: document.querySelector("#dateFromFilter"),
  dateTo: document.querySelector("#dateToFilter"),
  applyFilters: document.querySelector("#applyFilters"),
  resetFilters: document.querySelector("#resetFilters"),
  manualButton: document.querySelector("#manualButton"),
  reindexButton: document.querySelector("#reindexButton"),
  clearSearchButton: document.querySelector("#clearSearchButton"),
  loadOlderButton: document.querySelector("#loadOlderButton"),
  loadNewerButton: document.querySelector("#loadNewerButton"),
  previousSearchButton: document.querySelector("#previousSearchButton"),
  loadMoreSearchButton: document.querySelector("#loadMoreSearchButton"),
  latestButton: document.querySelector("#latestButton"),
  content: document.querySelector("#content"),
  emptyState: document.querySelector("#emptyState"),
  notice: document.querySelector("#notice"),
  viewEyebrow: document.querySelector("#viewEyebrow"),
  viewTitle: document.querySelector("#viewTitle"),
  viewDescription: document.querySelector("#viewDescription"),
  indexStatus: document.querySelector("#indexStatus"),
  telegramCount: document.querySelector("#telegramCount"),
  instagramCount: document.querySelector("#instagramCount"),
  threadsCount: document.querySelector("#threadsCount"),
  indexedAt: document.querySelector("#indexedAt"),
  toast: document.querySelector("#toast"),
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

async function api(path, options = {}) {
  return reader.api(path);
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value || 0));
}

function formatIndexedTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function storedTime(record) {
  return state.timezone === "france" ? record.sent_at_france : record.sent_at_china;
}

function formatStoredTime(value, includeDate = false) {
  if (!value) return "时间未知";
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return String(value);
  const [, year, month, day, hour, minute, second] = match;
  const time = second && second !== "00" ? `${hour}:${minute}:${second}` : `${hour}:${minute}`;
  return includeDate ? `${year}-${month}-${day} ${time}` : time;
}

function dateKey(record) {
  const value = storedTime(record);
  return value ? String(value).slice(0, 10) : "unknown";
}

function dateLabel(key) {
  if (key === "unknown") return "日期未知";
  const [year, month, day] = key.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

function platformLabel(platform) {
  return { telegram: "Telegram", instagram: "Instagram", threads: "Threads", manual: "手工补录" }[platform] || platform || "未知平台";
}

function topicLabel(topic) {
  return { work: "工作", personal: "私人", mixed: "混合", unclassified: "未分类" }[topic] || topic || "未分类";
}

function mediaTypeLabel(type) {
  if (String(type || "").startsWith("image/")) return "图片";
  if (String(type || "").startsWith("video/")) return "视频";
  if (String(type || "").startsWith("audio/")) return "音频";
  if (type === "application/pdf") return "PDF";
  return {
    photo: "图片",
    video: "视频",
    audio: "音频",
    voice: "语音",
    video_note: "视频消息",
    sticker: "贴纸",
    gif: "动图",
    document: "文件",
    file: "文件",
  }[type] || type || "附件";
}

function filters() {
  const params = new URLSearchParams();
  const selections = [
    ["platform", elements.platform.value],
    ["sender_role", elements.sender.value],
    ["conversation_id", elements.conversation.value],
    ["topic_class", elements.topic.value],
    ["deleted", elements.deleted.value],
    ["media_type", elements.media.value],
  ];
  for (const [key, value] of selections) {
    if (value && value !== "all") params.set(key, value);
  }
  if (elements.dateFrom.value) params.set("date_from", elements.dateFrom.value);
  if (elements.dateTo.value) params.set("date_to", elements.dateTo.value);
  return params;
}

function closeMobileFilters() {
  elements.sidebar.classList.remove("open");
  elements.filterToggle.setAttribute("aria-expanded", "false");
}

function showToast(message, duration = 3200) {
  if (!unlocked) return;
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => elements.toast.classList.add("hidden"), duration);
}

function showNotice(message) {
  elements.notice.textContent = message;
  elements.notice.classList.toggle("hidden", !message);
}

function setLoading(message) {
  clearRenderedMedia();
  elements.content.replaceChildren(node("div", "empty-state", message));
  elements.emptyState.classList.add("hidden");
}

function populateSelect(select, values, formatter) {
  const current = select.value;
  while (select.options.length > 1) select.remove(1);
  for (const value of values) {
    const option = document.createElement("option");
    option.value = typeof value === "string" ? value : value.value;
    option.textContent = formatter(value);
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function populateFacets(meta) {
  const conversations = (meta.facets?.conversations || []).map((item) => ({
    value: `${item.platform}\u001f${item.conversation_id}`,
    label: `${platformLabel(item.platform)} · ${item.conversation_id}（${formatNumber(item.count)}）`,
  }));
  populateSelect(elements.conversation, conversations, (item) => item.label);
  populateSelect(elements.topic, meta.facets?.topic_classes || [], (value) => topicLabel(value));
  populateSelect(elements.media, meta.facets?.media_types || [], (value) => mediaTypeLabel(value));
}

function updateMetaDisplay(meta) {
  const counts = meta.platform_counts || {};
  const total = Number(meta.record_counts?.message || 0);
  elements.archiveSummary.textContent = `${formatNumber(total)} 条平台消息 · ${formatNumber(meta.record_counts?.manual_transcript || 0)} 份手工补录`;
  elements.telegramCount.textContent = formatNumber(counts.telegram);
  elements.instagramCount.textContent = formatNumber(counts.instagram);
  elements.threadsCount.textContent = formatNumber(counts.threads);
  elements.indexedAt.textContent = formatIndexedTime(meta.published_at_utc || meta.indexed_at_utc);
  document.querySelector('#cutoffAt').textContent = formatIndexedTime(meta.data_cutoff_utc);
  elements.indexStatus.textContent = '已解锁';
  showNotice(Date.now() - Date.parse(meta.indexed_at_utc) > 48 * 3600000 ? '快照已超过 48 小时未更新；当前显示已同步的内容。' : '');
}

async function loadMeta(initial = false) {
  const meta = await api("/api/meta");
  const changed = state.indexedAt && meta.indexed_at_utc && state.indexedAt !== meta.indexed_at_utc;
  state.meta = meta;
  state.indexedAt = meta.indexed_at_utc;
  updateMetaDisplay(meta);
  if (initial) populateFacets(meta);
  if (changed) {
    populateFacets(meta);
    showToast("统一归档已更新，页面已载入新索引");
    await reloadCurrentView();
  }
}

function appendTextWithLinks(container, text) {
  const source = String(text || "");
  const pattern = /https?:\/\/[^\s<>]+/gi;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > cursor) container.append(document.createTextNode(source.slice(cursor, match.index)));
    const link = node("a", "", match[0]);
    link.href = match[0];
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    container.append(link);
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) container.append(document.createTextNode(source.slice(cursor)));
}

function appendHighlighted(container, text, query) {
  const source = String(text || "");
  const folded = source.toLocaleLowerCase();
  const needle = String(query || "").toLocaleLowerCase();
  if (!needle) {
    container.textContent = source;
    return;
  }
  let cursor = 0;
  let position = folded.indexOf(needle);
  while (position >= 0) {
    if (position > cursor) container.append(document.createTextNode(source.slice(cursor, position)));
    container.append(node("mark", "", source.slice(position, position + needle.length)));
    cursor = position + needle.length;
    position = folded.indexOf(needle, cursor);
  }
  if (cursor < source.length) container.append(document.createTextNode(source.slice(cursor)));
}

function nestedStrings(value, output = []) {
  if (typeof value === "string" && value.trim()) output.push(value.trim());
  else if (Array.isArray(value)) value.forEach((item) => nestedStrings(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => nestedStrings(item, output));
  return output;
}

function displayNestedStrings(value) {
  return nestedStrings(value).filter((item) => {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(item)) return false;
    if (/^(Message|Peer|Reaction)[A-Z]/.test(item)) return false;
    return true;
  });
}

function appendReply(bubble, record) {
  if (!record.reply_preview && !record.reply_record_id) return;
  const reply = node("button", "reply-card");
  reply.type = "button";
  if (record.reply_record_id) reply.dataset.contextId = record.reply_record_id;
  const name = record.reply_preview?.sender_name || "引用消息";
  reply.append(node("strong", "", name));
  reply.append(node("span", "", record.reply_preview?.text || "原消息未保存在当前归档"));
  bubble.append(reply);
}

function appendShare(bubble, record) {
  if (!record.share && !record.forward && !record.links?.length) return;
  const card = node("div", record.share ? "share-card" : "forward-card");
  card.append(node("strong", "", record.share ? "分享内容" : record.forward ? "转发内容" : "链接"));
  const values = displayNestedStrings(record.share || record.forward);
  const links = new Set(record.links || []);
  for (const value of values) {
    if (/^https?:\/\//i.test(value)) links.add(value);
  }
  const ordinary = values.filter((value) => !/^https?:\/\//i.test(value));
  for (const value of new Set(ordinary)) card.append(node("p", "", value));
  for (const href of links) {
    if (!/^https?:\/\//i.test(href)) continue;
    const link = node("a", "", href);
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    card.append(link);
  }
  bubble.append(card);
}

function reactionLabels(value, output = []) {
  if (output.length >= 24 || value === null || value === undefined) return output;
  if (typeof value === "string") {
    const trimmed = value.trim();
    const looksLikeReaction = /[\p{Extended_Pictographic}\u2600-\u27bf]/u.test(trimmed);
    if (trimmed && looksLikeReaction) output.push(trimmed);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => reactionLabels(item, output));
    return output;
  }
  if (typeof value === "object") {
    const symbol = value.reaction || value.emoticon || value.emoji;
    if (typeof symbol === "string") {
      const actor = value.actor_display_name || value.actor || value.actor_role;
      const count = value.count || value.total_count;
      output.push(`${symbol}${actor ? ` ${actor}` : count ? ` ${count}` : ""}`);
    } else {
      for (const item of Object.values(value)) reactionLabels(item, output);
    }
  }
  return output;
}

function appendReactions(bubble, record) {
  const labels = [...new Set(reactionLabels(record.reactions))];
  if (!labels.length) return;
  const row = node("div", "reaction-row");
  labels.forEach((label) => row.append(node("span", "reaction-chip", label)));
  bubble.append(row);
}

function appendMedia(bubble, record) {
  const items = record.media || [];
  if (!items.length) return;
  const grid = node("div", `media-grid${items.length === 1 ? " single" : ""}`);
  for (const media of items) {
    const wrapper = node("div", "media-item");
    if (!media.exists) {
      wrapper.append(node("div", "missing-media", media.reason || `附件不可用 · ${mediaTypeLabel(media.type)}`));
      grid.append(wrapper);
      continue;
    }
    const button = node('button', 'image-button');
    button.type = 'button';
    button.dataset.imageId = media.image_id;
    const image = node('img');
    image.alt = '聊天图片 · 点击查看原图';
    image.dataset.imageId = media.image_id;
    button.append(image);
    button.addEventListener('click', guard(() => openImage(media.image_id)));
    wrapper.append(button);
    imageObserver.observe(image);
    grid.append(wrapper);
  }
  bubble.append(grid);
}

function clearRenderedMedia() {
  imageObserver.disconnect();
  for (const url of blobURLs) URL.revokeObjectURL(url);
  blobURLs.clear();
}
const imageObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const image = entry.target;
    if (!entry.isIntersecting || image.dataset.loading || !unlocked) continue;
    image.dataset.loading = 'true';
    imageObserver.unobserve(image);
    const generation = reader.generation;
    reader.call('media', { id: image.dataset.imageId }).then(result => {
      if (!unlocked || reader.generation !== generation || !image.isConnected) return;
      const url = URL.createObjectURL(new Blob([result.data], { type: result.mime }));
      blobURLs.add(url); image.src = url;
    }).catch(error => {
      if (unlocked && image.isConnected && generation === reader.generation) {
        image.alt = '缩略图暂未加载，可点击重试原图';
        image.parentElement.title = error.message;
      }
    });
  }
}, { rootMargin: '200px' });

function closeImage() {
  imageGeneration++;
  document.querySelector('#imageDialog').close();
  document.querySelector('#originalImage').removeAttribute('src');
  document.querySelector('#originalImage').classList.remove('zoomed');
  document.querySelector('#downloadImage').removeAttribute('href');
  document.querySelector('#downloadImage').classList.add('hidden');
  if (imageURL) URL.revokeObjectURL(imageURL);
  imageURL = null;
}
async function openImage(id) {
  closeImage();
  const generation = reader.generation, request = ++imageGeneration;
  const dialog = document.querySelector('#imageDialog');
  document.querySelector('#imageStatus').textContent = '正在读取原图…';
  dialog.showModal();
  try {
    const result = await reader.call('media', { id, original: true });
    if (!unlocked || generation !== reader.generation || request !== imageGeneration || !dialog.open) return;
    imageURL = URL.createObjectURL(new Blob([result.data], { type: result.mime }));
    document.querySelector('#originalImage').src = imageURL;
    const download = document.querySelector('#downloadImage');
    download.href = imageURL;
    download.download = `image-${id.slice(0, 12)}.${{ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[result.mime] || 'bin'}`;
    download.classList.remove('hidden');
    document.querySelector('#imageStatus').textContent = '原始图片 · 点击图片切换缩放';
  } catch (error) {
    if (unlocked && request === imageGeneration) document.querySelector('#imageStatus').textContent = error.message;
  }
}

function versions(record) {
  const result = [];
  const groups = record.versions;
  if (!groups || typeof groups !== "object") return result;
  for (const [source, values] of Object.entries(groups)) {
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (!value || typeof value !== "object") continue;
      const text = value.text ?? value.content ?? value.source_text_raw;
      if (typeof text !== "string" || !text.trim()) continue;
      result.push({
        source,
        text,
        time: value.edited_at_utc || value.observed_at_utc || value.sent_at_utc,
        eventType: value.event_type,
      });
    }
  }
  return result;
}

function appendDetails(bubble, record, versionItems) {
  if (!record.has_history) return;
  const details = node("details", "message-details");
  details.append(node('summary', '', '历史详情'));
  let loaded = false, busy = false;
  details.addEventListener('toggle', async () => {
    if (!details.open || loaded || busy || !unlocked) return;
    busy = true;
    const content = node('div', 'history-content', '正在读取历史…');
    details.append(content);
    const generation = reader.generation;
    try {
      const history = await reader.call('history', { id: record.record_id });
      if (!unlocked || generation !== reader.generation || !details.isConnected) return;
      content.replaceChildren();
      for (const [source, values] of Object.entries(history.versions || {})) {
        for (const version of values) {
          const item = node('div', 'version-item');
          item.append(node('small', '', [source, version.event_type, formatIndexedTime(version.edited_at_utc || version.observed_at_utc || version.date)].filter(Boolean).join(' · ')));
          item.append(node('div', '', version.text ?? version.content ?? version.source_text_raw ?? '（无文字内容）'));
          if (version.forward || version.share || version.links?.length) appendShare(item, version);
          if (version.service_action && !version.text) item.append(node('div', '', serviceText(version.service_action)));
          appendReactions(item, version);
          appendMedia(item, version);
          content.append(item);
        }
      }
      for (const observation of history.delete_observations || []) content.append(node('div', 'version-item', `删除观测：${formatIndexedTime(observation.observed_at_utc)}`));
      loaded = true;
    } catch (error) { if (unlocked && content.isConnected) content.textContent = error.message; }
    finally { busy = false; }
  });
  bubble.append(details);
}

function createMessage(record) {
  const system = record.message_kind === "system";
  const role = system ? "system" : ["me", "her"].includes(record.sender_role) ? record.sender_role : "unknown";
  const row = node("article", `message-row ${role}`);
  row.dataset.recordId = record.record_id;
  const bubble = node("div", `message-bubble${record.deleted ? " deleted" : ""}${record.record_id === state.focusRecordId ? " focused" : ""}`);

  const allVersionItems = versions(record);
  const versionItems = allVersionItems.filter((version) =>
    version.text !== record.text || version.eventType === "edit_message" || allVersionItems.length > 1
  );
  const head = node("div", "message-head");
  head.append(node("span", "sender", record.sender_display_name || (record.sender_role === "me" ? "我" : record.sender_role === "her" ? "她" : "系统")));
  head.append(node("span", `platform-badge ${record.platform || ""}`, platformLabel(record.platform)));
  if (record.deleted) head.append(node("span", "status-badge deleted", "已删除"));
  if (record.edited_at_utc) head.append(node("span", "status-badge edited", "有编辑"));
  if (record.topic_class && record.topic_class !== "unclassified") head.append(node("span", "topic-badge", topicLabel(record.topic_class)));
  bubble.append(head);

  appendReply(bubble, record);
  appendShare(bubble, record);

  if (record.text) {
    const text = node("div", `message-text${record.text.length > 1300 ? " collapsed" : ""}`);
    appendTextWithLinks(text, record.text);
    bubble.append(text);
    if (record.text.length > 1300) {
      const expand = node("button", "expand-button", "展开全文");
      expand.type = "button";
      expand.addEventListener("click", () => {
        text.classList.toggle("collapsed");
        expand.textContent = text.classList.contains("collapsed") ? "展开全文" : "收起";
      });
      bubble.append(expand);
    }
  } else if (!(record.media || []).length && !record.share && !record.service_action) {
    bubble.append(node("div", "message-text", "（无文字内容）"));
  }

  if (record.service_action && !record.text) {
    bubble.append(node("div", "message-text", serviceText(record.service_action)));
  }
  appendMedia(bubble, record);
  if (record.media_notice) bubble.append(node('p', 'missing-media', record.media_notice));
  appendReactions(bubble, record);
  appendDetails(bubble, record, versionItems);

  const foot = node("div", "message-foot");
  foot.append(node("time", "", formatStoredTime(storedTime(record))));
  if (record.time_precision === "minute") foot.append(node("span", "", "分钟精度"));
  bubble.append(foot);
  row.append(bubble);
  return row;
}

function serviceText(action) {
  const period = action?.period ?? action?.ttl;
  if (action?._ === 'MessageActionSetMessagesTTL' && typeof period === 'number') {
    if (period === 0) return '关闭了消息自动删除';
    const duration = period % 86400 === 0 ? `${period / 86400} 天` : period % 3600 === 0 ? `${period / 3600} 小时` : period % 60 === 0 ? `${period / 60} 分钟` : `${period} 秒`;
    return `将消息自动删除时间设为 ${duration}`;
  }
  const label = { MessageActionSetMessagesTTL: '修改了消息自动删除设置', MessageActionPinMessage: '置顶了消息',
    MessageActionHistoryClear: '清理了聊天记录', MessageActionPhoneCall: '通话记录', MessageActionChatEditTitle: '修改了会话名称',
    MessageActionChatEditPhoto: '修改了会话图片', MessageActionChatAddUser: '添加了成员', MessageActionChatDeleteUser: '成员离开会话' }[action?._] || '系统事件';
  const values = displayNestedStrings(action);
  if (typeof action?.duration === 'number') values.push(`持续 ${action.duration} 秒`);
  if (typeof action?.amount === 'number') values.push(`金额记录 ${action.amount}`);
  const detail = values.join(' · ');
  return detail ? `${label} · ${detail}` : label;
}

function createManual(record) {
  const card = node("article", "manual-card");
  card.append(node("h3", "", "截图手工补录"));
  card.append(node("p", "", "这份补录没有可靠日期或正式消息编号，因此没有被放入时间线。"));
  for (const message of record.messages || []) {
    const item = node("div", `manual-message ${message.sender_role || "unknown"}`);
    if (message.reply_quote) item.append(node("div", "reply-card", message.reply_quote));
    item.append(document.createTextNode(message.text || ""));
    if (message.time_visible || message.visibility) {
      item.append(node("small", "", [message.time_visible, message.visibility].filter(Boolean).join(" · ")));
    }
    card.append(item);
  }
  const notes = nestedStrings(record.notes);
  if (notes.length) card.append(node("p", "", notes.join("；")));
  appendMedia(card, record);
  if (record.media_notice) card.append(node('p', 'missing-media', record.media_notice));
  return card;
}

function renderTimeline() {
  clearRenderedMedia();
  elements.content.className = "timeline";
  elements.content.replaceChildren();
  let previousDate = null;
  for (const record of state.items) {
    if (record.record_type === "manual_transcript") {
      elements.content.append(createManual(record));
      continue;
    }
    const currentDate = dateKey(record);
    if (currentDate !== previousDate) {
      elements.content.append(node("div", "date-divider", dateLabel(currentDate)));
      previousDate = currentDate;
    }
    elements.content.append(createMessage(record));
  }
  updateEmptyState();
  if (state.focusRecordId) {
    requestAnimationFrame(() => {
      const focused = [...document.querySelectorAll("[data-record-id]")].find((item) => item.dataset.recordId === state.focusRecordId);
      focused?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }
}

function renderSearchResults() {
  clearRenderedMedia();
  elements.content.className = "search-results";
  elements.content.replaceChildren();
  for (const record of state.items) {
    const card = node("article", "search-card");
    const head = node("div", "search-card-head");
    const left = node("span", "", `${record.sender_display_name || (record.sender_role === "me" ? "我" : record.sender_role === "her" ? "她" : "手工补录")} · ${platformLabel(record.platform)}`);
    const right = node("span", "", formatStoredTime(storedTime(record), true));
    head.append(left, right);
    card.append(head);
    if (record.deleted) card.append(node("span", "status-badge deleted", "已删除"));
    const snippet = node("p", "search-snippet");
    appendHighlighted(snippet, record.match_context || record.text || "（命中非正文内容）", state.searchQuery);
    card.append(snippet);
    const button = node("button", "context-button", record.record_type === "manual_transcript" ? "查看补录" : "定位到对话");
    button.type = "button";
    button.dataset.contextId = record.record_id;
    card.append(button);
    elements.content.append(card);
  }
  updateEmptyState();
}

function updateEmptyState() {
  elements.emptyState.classList.toggle("hidden", state.items.length > 0);
  elements.loadOlderButton.classList.toggle("hidden", !['timeline', 'context'].includes(state.mode) || !state.hasOlder);
  elements.loadNewerButton.classList.toggle('hidden', !['timeline', 'context'].includes(state.mode) || !state.hasNewer);
  elements.previousSearchButton.classList.toggle('hidden', state.mode !== 'search' || state.searchOffset <= 80);
  elements.loadMoreSearchButton.classList.toggle("hidden", state.mode !== "search" || !state.searchHasMore);
  elements.clearSearchButton.classList.toggle("hidden", state.mode === "timeline");
}

function updateHeading() {
  if (state.mode === "search") {
    elements.viewEyebrow.textContent = "全文检索";
    elements.viewTitle.textContent = `“${state.searchQuery}”的搜索结果`;
    elements.viewDescription.textContent = `${formatNumber(state.items.length)} 条已加载结果，默认按最新时间排列`;
  } else if (state.mode === "context") {
    elements.viewEyebrow.textContent = "消息上下文";
    elements.viewTitle.textContent = "定位到对话";
    elements.viewDescription.textContent = "显示目标消息前后的同一会话记录";
  } else if (state.mode === "manual") {
    elements.viewEyebrow.textContent = "日期未知";
    elements.viewTitle.textContent = "手工补录";
    elements.viewDescription.textContent = "没有可靠日期和正式消息编号的截图转录";
  } else {
    elements.viewEyebrow.textContent = "全部会话";
    elements.viewTitle.textContent = "最近聊天";
    elements.viewDescription.textContent = "按时间查看统一归档中的消息";
  }
}

async function loadTimeline(scrollToBottom = true) {
  const generation = ++viewGeneration;
  state.mode = "timeline";
  state.focusRecordId = null;
  state.contextConversation = null;
  state.searchQuery = "";
  state.searchOffset = 0;
  const params = filters();
  params.set("limit", "100");
  setLoading("正在读取最近聊天…");
  const payload = await api(`/api/messages?${params}`);
  if (!unlocked || generation !== viewGeneration) return;
  state.items = payload.items;
  state.oldestRowId = payload.oldest_row_id;
  state.newestRowId = payload.newest_row_id;
  state.hasOlder = payload.has_older;
  state.hasNewer = payload.has_newer;
  updateHeading();
  renderTimeline();
  if (scrollToBottom) requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }));
}

async function loadOlder() {
  if (!state.oldestRowId || !state.hasOlder) return;
  elements.loadOlderButton.disabled = true;
  const generation = ++viewGeneration;
  const anchor = [...elements.content.querySelectorAll('[data-record-id]')].find(el => el.getBoundingClientRect().bottom >= 90);
  const anchorId = anchor?.dataset.recordId, anchorTop = anchor?.getBoundingClientRect().top;
  try {
    const params = state.contextConversation ? new URLSearchParams({ conversation_id: state.contextConversation }) : filters();
    params.set("limit", "100");
    params.set("before", String(state.oldestRowId));
    const payload = await api(`/api/messages?${params}`);
    if (!unlocked || generation !== viewGeneration) return;
    const known = new Set(state.items.map((item) => item.record_id));
    const fresh = payload.items.filter((item) => !known.has(item.record_id));
    const combined = [...fresh, ...state.items];
    if (combined.length > 300) state.hasNewer = true;
    state.items = combined.slice(0, 300);
    state.oldestRowId = state.items[0]?.row_id || null;
    state.newestRowId = state.items.at(-1)?.row_id || null;
    state.hasOlder = payload.has_older;
    state.focusRecordId = null;
    renderTimeline();
    requestAnimationFrame(() => {
      if (!unlocked || generation !== viewGeneration) return;
      const current = [...elements.content.querySelectorAll('[data-record-id]')].find(el => el.dataset.recordId === anchorId);
      if (current && anchorTop !== undefined) window.scrollBy(0, current.getBoundingClientRect().top - anchorTop);
    });
  } finally {
    elements.loadOlderButton.disabled = false;
  }
}

async function loadNewer() {
  if (!state.newestRowId || !state.hasNewer) return;
  const generation = ++viewGeneration;
  const anchor = [...elements.content.querySelectorAll('[data-record-id]')].find(el => el.getBoundingClientRect().bottom >= 90);
  const anchorId = anchor?.dataset.recordId, anchorTop = anchor?.getBoundingClientRect().top;
  const params = state.contextConversation ? new URLSearchParams({ conversation_id: state.contextConversation }) : filters();
  params.set('after', String(state.newestRowId)); params.set('limit', '100');
  const payload = await api(`/api/messages?${params}`);
  if (!unlocked || generation !== viewGeneration) return;
  const combined = [...state.items, ...payload.items];
  if (combined.length > 300) state.hasOlder = true;
  state.items = combined.slice(-300);
  state.oldestRowId = state.items[0]?.row_id;
  state.newestRowId = state.items.at(-1)?.row_id;
  state.hasNewer = payload.has_newer;
  state.focusRecordId = null;
  renderTimeline();
  requestAnimationFrame(() => {
    if (!unlocked || generation !== viewGeneration) return;
    const current = [...elements.content.querySelectorAll('[data-record-id]')].find(el => el.dataset.recordId === anchorId);
    if (current && anchorTop !== undefined) window.scrollBy(0, current.getBoundingClientRect().top - anchorTop);
  });
}

async function runSearch(append = false) {
  const generation = ++viewGeneration;
  const query = elements.searchInput.value.trim();
  if (!query) {
    await loadTimeline(false);
    return;
  }
  state.mode = "search";
  state.focusRecordId = null;
  state.searchQuery = query;
  if (!append) {
    state.searchOffset = 0;
    setLoading("正在读取搜索索引并搜索…");
  }
  const params = filters();
  params.set("q", query);
  params.set("limit", "80");
  params.set("offset", String(state.searchOffset));
  const payload = await api(`/api/search?${params}`);
  if (!unlocked || generation !== viewGeneration) return;
  state.items = payload.items;
  state.searchOffset = payload.next_offset;
  state.searchHasMore = payload.has_more;
  updateHeading();
  renderSearchResults();
}

async function loadContext(recordId) {
  const generation = ++viewGeneration;
  state.mode = "context";
  state.focusRecordId = recordId;
  setLoading("正在读取前后聊天…");
  const params = new URLSearchParams({ around: recordId, limit: "81" });
  const payload = await api(`/api/messages?${params}`);
  if (!unlocked || generation !== viewGeneration) return;
  state.items = payload.items;
  state.contextConversation = payload.conversation;
  state.oldestRowId = payload.oldest_row_id;
  state.newestRowId = payload.newest_row_id;
  state.hasOlder = payload.has_older;
  state.hasNewer = payload.has_newer;
  updateHeading();
  renderTimeline();
}

async function loadManual() {
  const generation = ++viewGeneration;
  state.mode = "manual";
  state.focusRecordId = null;
  setLoading("正在读取手工补录…");
  const payload = await api("/api/messages?platform=manual&limit=50");
  if (!unlocked || generation !== viewGeneration) return;
  state.items = payload.items;
  state.hasOlder = false;
  state.hasNewer = false;
  updateHeading();
  renderTimeline();
  closeMobileFilters();
}

async function reloadCurrentView() {
  if (state.mode === "search") await runSearch(false);
  else if (state.mode === "manual") await loadManual();
  else if (state.mode === "context" && state.focusRecordId) await loadContext(state.focusRecordId);
  else await loadTimeline(false);
}

function resetFilterControls() {
  elements.platform.value = "all";
  elements.sender.value = "all";
  elements.conversation.value = "all";
  elements.topic.value = "all";
  elements.deleted.value = "all";
  elements.media.value = "all";
  elements.dateFrom.value = "";
  elements.dateTo.value = "";
}

function guard(task) {
  return async (...args) => {
    try {
      await task(...args);
    } catch (error) {
      if (!unlocked || error.name === 'AbortError') return;
      showToast(error.message || "读取失败", 5000);
      elements.content.replaceChildren();
      elements.emptyState.classList.remove("hidden");
    }
  };
}

document.querySelectorAll("[data-timezone]").forEach((button) => {
  button.addEventListener("click", () => {
    state.timezone = button.dataset.timezone;
    document.querySelectorAll("[data-timezone]").forEach((item) => item.classList.toggle("active", item === button));
    if (state.mode === "search") renderSearchResults();
    else renderTimeline();
  });
});

elements.searchForm.addEventListener("submit", guard(async (event) => {
  event.preventDefault();
  closeMobileFilters();
  await runSearch(false);
}));

elements.applyFilters.addEventListener("click", guard(async () => {
  closeMobileFilters();
  if (elements.searchInput.value.trim()) await runSearch(false);
  else await loadTimeline(false);
}));

elements.resetFilters.addEventListener("click", guard(async () => {
  resetFilterControls();
  elements.searchInput.value = "";
  closeMobileFilters();
  await loadTimeline(false);
}));

elements.clearSearchButton.addEventListener("click", guard(async () => {
  elements.searchInput.value = "";
  await loadTimeline(true);
}));

elements.manualButton.addEventListener("click", guard(loadManual));
elements.loadOlderButton.addEventListener("click", guard(loadOlder));
elements.loadNewerButton.addEventListener('click', guard(loadNewer));
elements.previousSearchButton.addEventListener('click', guard(async () => {
  state.searchOffset = Math.max(0, state.searchOffset - state.items.length - 80);
  await runSearch(true);
}));
elements.loadMoreSearchButton.addEventListener("click", guard(() => runSearch(true)));
elements.latestButton.addEventListener("click", guard(() => loadTimeline(true)));

elements.reindexButton.addEventListener("click", guard(async () => {
  elements.reindexButton.disabled = true;
  try {
    if (elements.reindexButton.dataset.changed) { lockPage('请输入密码读取最新版本'); return; }
    const result = await reader.call('check');
    if (result.changed) {
      showNotice('有新版本可用。点击“重新解锁新版”读取；当前阅读位置保留到本次锁定前。');
      elements.reindexButton.textContent = '重新解锁新版';
      elements.reindexButton.dataset.changed = 'true';
    } else showToast('当前已是最新发布版本');
  } finally { elements.reindexButton.disabled = false; }
}));

elements.filterToggle.addEventListener("click", () => {
  const open = elements.sidebar.classList.toggle("open");
  elements.filterToggle.setAttribute("aria-expanded", String(open));
});

elements.content.addEventListener("click", guard(async (event) => {
  const button = event.target.closest("[data-context-id]");
  if (!button) return;
  await loadContext(button.dataset.contextId);
}));

window.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
    event.preventDefault();
    elements.searchInput.focus();
  }
  if (event.key === "Escape" && elements.sidebar.classList.contains("open")) closeMobileFilters();
});

function lockPage(message = '已锁定，请重新输入密码') {
  unlocked = false; viewGeneration++;
  reader.lock();
  closeImage(); clearRenderedMedia();
  state.items = []; state.meta = null; state.searchQuery = ''; state.focusRecordId = null;
  state.contextConversation = null; state.indexedAt = null; state.searchOffset = 0;
  elements.content.replaceChildren(); elements.searchInput.value = ''; elements.notice.textContent = '';
  elements.toast.textContent = ''; elements.toast.classList.add('hidden');
  elements.archiveSummary.textContent = ''; elements.viewTitle.textContent = ''; elements.viewDescription.textContent = '';
  for (const select of [elements.conversation, elements.topic, elements.media]) while (select.options.length > 1) select.remove(1);
  resetFilterControls(); closeMobileFilters();
  for (const id of ['telegramCount', 'instagramCount', 'threadsCount', 'indexedAt', 'cutoffAt', 'indexStatus']) document.getElementById(id).textContent = '—';
  elements.reindexButton.textContent = '检查更新'; delete elements.reindexButton.dataset.changed;
  for (const button of document.querySelectorAll('#readerScreen button')) button.disabled = false;
  document.querySelector('#readerScreen').classList.add('hidden'); document.querySelector('#readerScreen').inert = true;
  document.querySelector('#lockScreen').classList.remove('hidden');
  document.querySelector('#passwordInput').value = '';
  document.querySelector('#unlockStatus').textContent = message;
  document.querySelector('#unlockButton').disabled = false;
}
document.querySelector('#unlockForm').addEventListener('submit', async event => {
  event.preventDefault();
  const input = document.querySelector('#passwordInput'), button = document.querySelector('#unlockButton');
  if (!window.crypto?.subtle || !window.Worker || !window.DecompressionStream) {
    document.querySelector('#unlockStatus').textContent = '请使用支持 HTTPS 和 Web Crypto 的新版 Chrome、Edge 或 Safari。'; return;
  }
  button.disabled = true;
  document.querySelector('#unlockStatus').textContent = '正在解锁…';
  const password = input.value; input.value = '';
  let generation;
  try {
    const promise = reader.unlock(password);
    generation = reader.generation;
    const meta = await promise;
    if (generation !== reader.generation) return;
    unlocked = true; lastActivity = Date.now(); state.meta = meta;
    document.querySelector('#lockScreen').classList.add('hidden');
    document.querySelector('#unlockStatus').textContent = '';
    document.querySelector('#readerScreen').classList.remove('hidden'); document.querySelector('#readerScreen').inert = false;
    updateMetaDisplay(meta); populateFacets(meta);
    await loadTimeline(true);
  } catch (error) {
    if (generation === reader.generation) lockPage(error.name === 'AbortError' ? '已锁定，请重新输入密码' : error.message);
  } finally { if (generation === reader.generation) button.disabled = false; }
});
document.querySelector('#lockButton').addEventListener('click', () => lockPage());
document.querySelector('#closeImage').addEventListener('click', closeImage);
document.querySelector('#imageDialog').addEventListener('cancel', event => { event.preventDefault(); closeImage(); });
document.querySelector('#originalImage').addEventListener('click', event => event.target.classList.toggle('zoomed'));
function checkExpiry() { if (unlocked && Date.now() - lastActivity >= 15 * 60 * 1000) lockPage('闲置超过 15 分钟，已自动锁定'); }
for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'input']) window.addEventListener(type, () => { checkExpiry(); if (unlocked) lastActivity = Date.now(); }, { passive: true });
window.setInterval(checkExpiry, 10000);
document.addEventListener('visibilitychange', checkExpiry);
window.addEventListener('pagehide', () => lockPage());
window.addEventListener('pageshow', event => { if (event.persisted) lockPage(); });
