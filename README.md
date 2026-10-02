# Mac Notes

A lightweight macOS-dark notes app built with vanilla HTML/CSS/JS.

## Run locally

Open `index.html` in a modern browser. For a more reliable local origin:

```bash
cd mac-notes
python -m http.server 8000
```

Then visit `http://localhost:8000`.

## Files

- `index.html`
- `styles.css`
- `app.js`

## Important

Private vault note data is AES-encrypted in localStorage using CryptoJS.
Do not hard-code a GitHub Personal Access Token into this static front-end.
