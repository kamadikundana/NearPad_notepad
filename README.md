# NearPad

Encrypted shared notepad for two nearby laptops on the same Wi-Fi. No server, no account, no internet.

```
npm install
npm start          # run on each laptop
npm test           # crypto + session tests
npm run e2e        # launches two real windows and pairs them
```

## Using it
1. Laptop A: **Start session** -> shows a code like `K7QM-4XPD` (expires in 2 min).
2. Laptop B: **Scan** (or type A's address) + enter the code -> **Join**.
3. Type on either laptop; it appears on the other. **Save** writes a plain .txt; **Exit** wipes the session.
Closing the window hides it to the tray; Quit from the tray menu also wipes the session.

## Security model
- **Pairing:** SPAKE2 (ristretto255, `@noble/curves`) using the code. The code is never sent; an
  eavesdropper cannot test guesses offline. Key confirmation proves both sides typed the same code.
- **Code:** 8 chars (40 bits), single use, 2-minute expiry, 3 wrong attempts burn it, one handshake at a
  time, one paired guest only.
- **Traffic:** AES-256-GCM, per-direction keys, strictly increasing counter (tamper/replay/reorder
  rejected; any bad frame drops the link).
- **Discovery:** UDP broadcast that reveals only "NearPad host at this address"; never the code.
- **Electron:** sandbox + contextIsolation, no Node in the page, strict CSP, navigation/new windows/webviews
  blocked, all web permissions denied, IPC restricted to our page with input validation, remote text only
  ever placed in `textarea.value`, toasts never show note content, single instance.
- **Wipe:** Exit/Quit zeroes session keys and destroys the document.

## Known limits (be honest)
- The SPAKE2 composition is built from audited primitives but has **not been independently audited**.
- JavaScript strings can't be reliably zeroed, so note text may linger in process memory until GC/exit.
- **Save writes plain text** to disk. Anyone at the paired laptop's screen sees the notes.
- A network attacker can burn your code by failing 3 guesses (denial of service); just start a new session.
- Malware on either laptop defeats everything. Encryption protects the network path only.
- Windows Firewall will ask to allow NearPad on first run; allow **Private** networks only.
- Before shipping a packaged build: enable Electron fuses, code-sign, and keep Electron updated.
