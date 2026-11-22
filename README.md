# RSA Check

**Shoulder arthroplasty X-ray and CT assessment, entirely in your browser.**

Live site: **https://treff89.github.io/RSA/**

Open a shoulder radiograph or CT. Metal implants are found automatically, you place or confirm a handful of bony
landmarks, and every parameter is reported as a raw number, colour-coded against its published range, with the source
of that range and a frank appraisal of what is and is not within it.

| Study type | X-ray | CT |
|---|---|---|
| **Reverse replacement** | Lateralisation and distalisation shoulder angles, acromion–tuberosity distance, lateral offsets, deltoid moment arm and wrapping angle, glenosphere inclination, inferior overhang, stem alignment, filling ratios, arm position (HARA, SHARA); notching, fixation, acromial fracture | Glenosphere version and inclination in 3D, measured diameter, overhang, centre-of-rotation offset; seating, screws, notching, fractures; muscles |
| **Pyrocarbon hemiarthroplasty** | Centre-of-rotation deviation from the native best-fit circle, head size mismatch, head height, an explicit **overstuffing** verdict, acromiohumeral distance, glenoid medialisation, Schippers' medialisation and upward migration (as a share of shaft diameter), stem fit; axillary subluxation | Glenoid version and inclination, head centring (two subluxation indices), erosion; muscles |
| **Native shoulder** | Critical shoulder angle, acromion index, lateral acromial angle, acromiohumeral and acromion–tuberosity distances, inclination, RSA angle, head size, Samilson–Prieto, deltoid tuberosity index; Hamada, Favard; axillary version and subluxation; **scapular Y-view**: posterior acromial height, tilt and coverage (Gerber's group, posterior instability) | 3D Friedman version, inclination, subluxation, Walch type suggestion; muscle fat fraction and atrophy |

**Arm position normalised.** The arm hangs in different abduction on every film, and that alone moves the LSA, DSA,
acromion–tuberosity distance and offsets. *Arm position* (under the implant size) can take the measurements as the film
was taken, with the **arm vertical** (HARA 0°), or **relative to the scapula** (SHARA 104°, the mean scapular
orientation of standing films with the arm vertical, which also removes scapular rotation). The humerus and its implant
are rotated rigidly about the centre of rotation (the glenosphere centre, or the head centre on hemi and native films)
and everything is measured on the rotated landmarks; a purple outline shows the humerus as measured, and the landmarks
you placed are not moved. On 24 annotated reverse films the DSA correlated with HARA at r = −0.51 as taken and 0.07
after normalising (LSA 0.36 → −0.19), and across those films LSA rose about 4° and DSA fell about 6° per 10° of
abduction, close to the 5° and 7° the rotation predicts. It is an in-plane correction: humeral rotation, flexion and
scapular tilt are not corrected, and on native and hemi films the acromiohumeral distance does not change (the head
turns about its own centre). Native films need the humeral shaft line, found automatically when enough shaft is on the
film. With both films normalised, the Compare tab compares them at the same arm position.

**Comparison.** On a reverse film, *Add pre-op X-ray* in the *Comparison* tab loads the pre-operative film (anonymised
like the rest); the post-operative humerus is turned about the glenosphere centre to the pre-operative arm position
(relative to the scapula when both films have the fossa line), and distalisation, lateralisation, acromiohumeral and
acromion–tuberosity distances, global lateral offset, tuberosity-to-centre distance and centre-of-rotation shift are
listed before and after. With two films of the same implant, the tab pairs them (earlier and current) and lists
what changed: arm lengthening and humeral lateralisation from a pre-operative film; on follow-up, the acromion–tuberosity
distance (a rise suggests acromial fracture), stem subsidence relative to the tuberosity, glenosphere tilt and centre of
rotation (baseplate shift), stem tilt, Schippers' medialisation and upward migration (graded per month when you enter the
interval), and progression of the gradings (notching, erosion, lucency). Distances are put on a common scale — the
implant on both films, or the glenoid height carried over from a calibrated film — and the tab warns when the arm hangs
in a different position (HARA differs by more than 10°), because that alone moves the LSA and DSA. Open both films
together; each image can be given its own study type (for example a pre-operative native film next to a reverse).

For native shoulders an **Implant choice** tab combines the measurements with age and cuff status into a transparent,
weighted reading of anatomic versus reverse replacement.

> Not a medical device. For audit, teaching and research; not for diagnosis. Every number depends on where the
> landmarks are put and on the quality of the view. Check it against the images.

## Privacy: nothing is uploaded

* The site is a static page. Reading, anonymisation, decoding, detection and measurement run in a Web Worker **on your
  device**.
* The page is served with a Content-Security-Policy of `connect-src 'none'`: the browser itself refuses every outgoing
  request from the page and its worker, so an image *cannot* be sent anywhere — not overseas, not anywhere. You can
  confirm it in the browser's developer tools (Network tab): after the page has loaded, nothing else is requested.
  The end-to-end test asserts this.
* **Anonymisation happens as each DICOM file is read.** A whitelist keeps only what is needed to display and measure
  the image (matrix size, pixel spacing and magnification, bit depth, photometric interpretation, window, laterality,
  view position, slice geometry for CT). Patient name, ID, birth date, every date and time, accession numbers,
  institution, staff, device serial numbers, UIDs, comments and private tags are discarded and never stored, shown or
  logged. Descriptions containing fragments of the patient's name are blanked. File and folder names are never kept.
* Reports and exports are built from measurements only. The test suite plants identifiers in a synthetic DICOM file
  and checks that none of them — nor the file name — appears anywhere in the page, its state or any export.
* One thing the software cannot remove: text **burned into the pixels** of a screenshot or secondary capture. It never
  leaves your device, but it would be visible in an exported annotated image; the app warns when that is possible.

## What is automatic, and what is not

You choose the study type (reverse, pyrocarbon/hemi, native) when you open the images; each radiograph is then
analysed as that type. On a radiograph **every landmark is placed automatically**; you check and drag.

* **Implant landmarks are measured.** Metal is found by two independent, validated methods combined: a threshold
  search for the region whose outline lies on crisp edges, and a marker-controlled watershed on the gradient image
  (which finds metal even where it is barely brighter than the tissue beside it, as on many processed and
  published films). Figure margins are peeled off, coloured annotations and viewer text are painted out, and label
  boxes are ignored. The stem is traced on the most elongated metal body; the glenosphere or head is the best
  convex arc of the metal outline that is anatomically placed (beyond the stem for a glenosphere, on it for a head);
  the glenosphere face comes from the implant's own straight back edge.
* **Bony landmarks are learned.** Positions of the acromion, glenoid rim, tuberosity, fossa floor and best-fit-circle
  points were learned from annotated radiographs, relative to the implant (`src/detect/model.json`, written by
  `test/corpus/learn.mjs`). Each landmark uses whichever method scored best in leave-one-out testing: its learned
  position, a search for its learned local appearance, or the extreme point of the bony outline nearby. They are
  drawn dashed and listed as "Estimated — check"; measurements resting on them are **provisional** until confirmed.
* **Correct the implant and the rest follows.** Dragging or re-placing the glenosphere, its face, the head or the
  stem re-places every bony landmark that is still an estimate; anything you placed or confirmed stays where it is.
* **CT**: the implant and humeral head are detected; bony CT landmarks are placed by you.
* **Not yet learned** (placed by you): the deltoid tuberosity, the humeral shaft diameter and centre line, and the four
  Y-view points. The supraspinatus fossa line on hemi and native films and the native acromial undersurface line start
  from rough estimates built from the glenoid and acromion points, drawn dashed to be checked.
* **Gradings are yours** — notching, lucency, Hamada, Walch, erosion.

### How well does it work? Candidly:

Measured on a development corpus of about 870 openly available radiographs (journal figures, a shoulder surgeon's
teaching blog, an open dataset — kept out of this repository), 220 of them with landmarks annotated by hand. The
figures below are **held out**: each film was placed by a model that had not been trained on it (two-fold split of the
150 most recently annotated films), running the whole pipeline. Errors are fractions of the implant radius (about
19 mm for a glenosphere; the head radius on hemi and native films), median and 75th percentile.

* **Glenosphere**: centre within 0.04 R (median) when found.
* **Reverse bony landmarks** (74 films): acromion undersurface 0.18 (75th 0.95), inferior glenoid rim 0.21 (0.45),
  superior tubercle 0.32 (0.58), top of the tuberosity 0.44 (0.95), lateral tuberosity 0.52 (1.0), acromion tip
  0.59 (1.4). The long tail is mostly films where the glenosphere's back face is misread by 10–40°, which swings
  everything on the scapula; correcting the face re-places them. Treat them as a head start to check.
* **Native shoulders** (10 films): head 0.08, glenoid rim 0.11–0.13, tuberosity 0.10–0.11, acromion undersurface
  0.15, acromion tip 0.32.
* **Hemiarthroplasty** (14–16 films): head 0.06, glenoid rim 0.18–0.23, acromion 0.23–0.30, tuberosity 0.25,
  best-fit-circle points 0.2–0.64.
* **Canal lines** come from tracing both cortices along the whole stem (median-filtered, robust fit), and the stem
  widths are measured on the metal; they have not been checked against hand-placed canal lines.
* Computing LSA and DSA from annotated landmarks reproduces the values printed in the source articles to within
  about 1–2°, which checks the measurement definitions. No real CT has been tested.

## How the numbers are judged

Each measurement carries its definition, its reference band, an **evidence level**, its limits, and its sources:

| Evidence level | Meaning |
|---|---|
| Published cut-off | A threshold reported in the literature and tied to an outcome |
| Published range — not reproduced | Reported once, not confirmed by later, larger studies (the LSA and DSA bands are here) |
| Descriptive norm | Population means; shown for context, not graded |
| Pragmatic | No validated cut-off exists; the band is a stated convention |

Colours: green within range, amber borderline, red outside in the direction the literature links to a problem, blue
descriptive. Each citation is tagged with how it was checked while the tool was written — *checked against the paper*,
*quoted second-hand* or *from memory — verify* — see `src/measure/refs.js`. Some honest highlights:

* **LSA 75–95° / DSA 40–65°** (Boutsiadis 2018) come from 46 shoulders. Series of 630 and 203 shoulders found little
  or no link with outcome, and on CT the angles track true lateralisation and distalisation only weakly. They are
  shown as reference bands, not targets.
* **Acromion–tuberosity distance**: > 38 mm predicted good elevation in one series; it is not a safety limit.
* **Overstuffing**: no radiographic criterion has been prospectively validated, and experienced surgeons agree poorly
  by eye (kappa ≈ 0.25). The verdict combines centre-of-rotation deviation (> 3 mm, medial or superior), head size and
  head height, and says so.
* **Newer measures, frankly**: the deltoid moment arm and wrapping angle are descriptive (one series' means, no
  cut-off); the lateral acromial angle's 70° limit comes from eight MRI shoulders; the posterior acromial height's
  23 mm comes from one case-control series (odds ratio 39), with tilt and coverage graded at pragmatic midpoints
  between group means; Schippers' indices are meaningful only as change between films.
* **Anatomic versus reverse** is a weighted checklist with every weight on show. It is not a validated prediction —
  none exists — and it says plainly when the cuff, the deciding factor, has not been assessed.

## Muscle analysis (CT)

Public research and repositories were surveyed for an automatic rotator-cuff segmentation that could run here. None
is usable: the EPFL (Terrier 2017, Taghizadeh 2021) code and weights are unpublished, and the TotalSegmentator
shoulder-muscle model is licence-gated and has no in-browser build. So the app re-implements the *published method*:

* a **scapular Y-view** is reformatted automatically, perpendicular to the scapular axis, once the trigonum and the
  glenoid are marked;
* you outline each muscle (supraspinatus, infraspinatus, subscapularis, teres minor, deltoid) and, optionally, its
  premorbid outline or fossa;
* from the Hounsfield values inside the outline (nearest voxel, not interpolated): **fat fraction** (fat −190…−30 HU,
  Aubrey 2014), mean attenuation, area, the supraspinatus **occupation ratio** (Thomazeau) and the Terrier
  atrophy / infiltration / **degeneration** ratios;
* fat fraction is compared with the mean 3D fat fraction per Goutallier grade (Werthel 2022). These are group means,
  not validated cut-offs, and the app says so.

## Using it

1. Pick the study type and drop files (DICOM radiographs, a CT folder, a `.zip`, or PNG/JPEG images).
2. For a radiograph with an implant, choose the **glenosphere or head size**: its outline then calibrates the image,
   removing film magnification. Without it, distances use the stored pixel spacing (typically 5–15% too large) or are
   withheld.
3. Landmarks are placed automatically. Check the implant first (glenosphere or head circle, face, stem) — correcting
   it re-places the bony estimates — then drag any bony landmark that is off (a magnifier appears) and press
   *Confirm estimates*. *Place the next one* walks through anything that could not be placed.
4. Read **Measurements** (click a row to highlight its construction lines) and **Appraisal**; export the report as
   text, the raw data as CSV, everything including landmark coordinates as JSON, or the annotated image.

*Try a synthetic example* on the start page loads a computer-generated phantom of the selected type.

## Development

```bash
npm install
```

```bash
npm test
```

```bash
npm run build
```

```bash
npm run e2e
```

* `src/dicom/` — anonymising DICOM intake (CT series and radiographs), shared with the sibling project 3dbones.
* `src/detect/` — automatic detection (`xray.js`, `ct.js`); `src/sample/` — synthetic phantoms with ground truth.
* `src/measure/` — geometry, the protocol engine, one declarative protocol per study type, muscle analysis, the
  implant-choice synthesis, and the reference list.
* `src/app/` — viewer (2D and multi-planar), panel, report builders; `src/worker/` — the Web Worker.
* `test/corpus/` evaluates the pipeline on a local corpus of real films and learns the landmark model
  (`eval.mjs`, `learn.mjs`, `draw.py`); the corpus itself is not distributed.
* `npm test` runs 114 unit tests (measurement geometry on both sides and with a tilted patient, detection against
  phantom truth, anonymisation, reports). `npm run e2e` drives the built site in headless Chromium (needs Playwright):
  all six study types, the Y-view, a DICOM file with planted identifiers, landmark placement, muscle outlines, two films
  compared, exports, and the no-network guarantee.

Pushing to `main` runs the tests and publishes `dist/` to the `gh-pages` branch (Settings → Pages → Deploy from a
branch → `gh-pages` / root).

MIT licence.
