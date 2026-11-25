# Reader corrections

Files here are exports from the app's **training mode** (Landmarks tab → *Export corrections*). Every build folds
all of them into the learned landmark model (`build.mjs` → `src/detect/training-merge.js`), so the next deploy
places landmarks the way the readers corrected them. Each correction counts three times one annotated corpus film.

To add one: in the app use *Add to the repo ↗* (GitHub's upload page for this folder), drop the exported
`rsa-check-training-*.json` on it and commit to `main`. Pushing to `main` runs the tests and redeploys.

A file holds no image and nothing identifying: per correction, the landmark, the implant type, its position in the
implant's own frame (units of the glenosphere / head radius), a small normalised appearance patch, and a timestamp.
Malformed records are dropped at build time. Delete a file to take its corrections out again.
