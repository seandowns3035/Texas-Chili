# Texas Chili — setup

Two things to set up, once: a free Firebase database (for the shared game
state), and a free host (for the actual URL). Neither costs money and your
brothers don't need accounts for either.

## 1. Firebase Realtime Database (5 minutes)

1. Go to https://console.firebase.google.com and sign in with any Google account.
2. Click **Add project**. Name it anything (e.g. "texas-chili"). You can
   disable Google Analytics for this project — not needed.
3. Once created, click the **</> (Web)** icon on the project overview page
   to register a web app. Name it anything, click **Register app**.
4. Firebase shows you a `firebaseConfig` object. Copy the whole thing.
5. Open `src/firebase.js` in this project and paste your values over the
   placeholder ones (`YOUR_API_KEY`, etc.). This is safe to make public —
   it's a client identifier, not a secret.
6. In the left sidebar, go to **Build > Realtime Database**. Click
   **Create Database**. Choose any location. Start in **locked mode**
   (doesn't matter, we're about to set custom rules).
7. Click the **Rules** tab. Delete what's there and paste in the contents
   of `database.rules.json` from this project. Click **Publish**.
   This restricts reads/writes to just the `/rooms` path — nobody can use
   your database for anything else.

## 2. Deploy it somewhere (no terminal needed)

**Easiest path — GitHub + Vercel:**

1. Go to https://github.com, make a free account if you don't have one.
2. Create a new repository (any name, e.g. `texas-chili`).
3. On the repo page, click **Add file > Upload files**, and drag in every
   file and folder from this project (keep the `src` folder structure).
4. Commit the upload.
5. Go to https://vercel.com, sign up with the same GitHub account (one click).
6. Click **Add New > Project**, pick your `texas-chili` repo, click **Deploy**.
   Vercel auto-detects Vite and builds it — no configuration needed.
7. When it finishes, Vercel gives you a permanent URL like
   `texas-chili.vercel.app`. That's the link to send your brothers.

**If you're comfortable with a terminal instead:**

```
npm install
npm run dev        # test locally first
npm run build       # then, to deploy:
npx vercel --prod
```

## 3. Home screen icon

Once it's live at its own URL (not on claude.ai), the earlier "Add to Home
Screen" problem goes away — there's no login wall for it to fall back to,
and the `apple-mobile-web-app-*` tags in `index.html` mean it'll pick up
the name "Texas Chili" automatically, launch full-screen, no browser bar.

## Notes

- Every player just opens the Vercel URL in Safari. No Claude account, no
  Firebase account, no login of any kind required for them.
- If you ever want to update the game, ask Claude for the changed
  `App.jsx`, re-upload it to GitHub, and Vercel redeploys automatically.
- Firebase's free (Spark) tier includes 1GB storage and 10GB/month of
  transfer — this game uses a few KB per room. You will not come close
  to any limit at family scale.
