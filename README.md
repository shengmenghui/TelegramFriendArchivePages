# Encrypted chat reader

TFA-PAGES-READER-1

A static reader using a shared password and browser-side AES-GCM decryption.
Only generic frontend code and encrypted reading snapshots are published here.
No plaintext archive, passwords, publishing keys or login sessions belong in this repository.

The site uses no analytics or third-party browser scripts. Unlocking happens locally.
Closing/reloading the page or leaving it idle for 15 minutes locks it again.

The password cannot be recovered from this repository. Ask the archive owner for it.
The ciphertext is public; use a strong randomly generated shared password.
Changing a password cannot revoke copies that another reader already saved.

GitHub Actions assembles the snapshot pinned by `current.json`, verifies every package
and object, then deploys the current encrypted site. Old release packages are retained.
The full recovery archive is separate and is never used as a Pages build input.
