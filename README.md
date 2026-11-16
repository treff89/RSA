# RSA Check

**Shoulder arthroplasty X-ray and CT assessment, entirely in your browser.**

Live site: **https://treff89.github.io/RSA/**

Open a shoulder radiograph or CT. Metal implants are found automatically, you place or confirm a handful of bony
landmarks, and every parameter is reported as a raw number, colour-coded against its published range, with the source
of that range and a frank appraisal of what is and is not within it.

| Study type | X-ray | CT |
|---|---|---|
| **Reverse replacement** | Lateralisation and distalisation shoulder angles, acromion–tuberosity distance, lateral offsets, glenosphere inclination, inferior overhang, stem alignment, filling ratios; notching, fixation, acromial fracture | Glenosphere version and inclination in 3D, measured diameter, overhang, centre-of-rotation offset; seating, screws, notching, fractures; muscles |
| **Pyrocarbon hemiarthroplasty** | Centre-of-rotation deviation from the native best-fit circle, head size mismatch, head height, an explicit **overstuffing** verdict, acromiohumeral distance, glenoid medialisation, stem fit; axillary subluxation | Glenoid version and inclination, head centring (two subluxation indices), erosion; muscles |
| **Native shoulder** | Critical shoulder angle, acromion index, acromiohumeral distance, inclination, RSA angle, head size, Samilson–Prieto, deltoid tuberosity index; Hamada, Favard; axillary version and subluxation | 3D Friedman version, inclination, subluxation, Walch type suggestion; muscle fat fraction and atrophy |

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

Detection is classical image analysis (no machine-learning model, nothing downloaded):

* **Radiographs** — metal segmentation; the glenosphere as a circle with its flat back face and axis; the humeral stem
  axis and widths; a prosthetic or bony humeral head circle. An implant found with low confidence is shown as an
  *estimate to check*, never as a detection.
* **CT** — metal segmentation; a sphere fitted to the glenosphere with its axis; the stem axis; the humeral head
  (native or prosthetic) as a sphere.
* **Bony landmarks are yours.** The acromion, glenoid rim, tuberosity, fossa floor, trigonum and so on are placed by
  clicking (a magnifier helps), or dragged from the software's estimate. Estimated positions are drawn dashed, listed
  as "Estimated — check", and every measurement resting on one is labelled **provisional** until you confirm it.
* **Gradings are yours too** — notching, lucency, Hamada, Walch, erosion. The software does not pretend to grade them.

### How well does detection work? Candidly:

* On **synthetic phantoms** with known geometry (the test suite): glenosphere centre within 0.1 mm and stem axis
  within 0.1° on radiographs; glenosphere centre within 0.2 mm, axis within 1° and version/inclination within 0.5° on
  CT; humeral head within 0.1 mm.
* On **real images** it has barely been tested. One openly licensed reverse-shoulder radiograph (Wikimedia Commons)
  was tried during development. It exposed two ways real films differ from the phantoms — implants are round, so
  their brightness has no plateau, and the humeral tray overlaps the glenosphere so the metal forms one body — and
  both now have a fallback. On that film the glenosphere circle is found and offered as a *low-confidence estimate*;
  its back face is not found and must be placed (two clicks), and the stem axis is a few degrees off and marked for
  checking. One film is not validation: expect to correct or place the implant landmarks yourself on some images.
  No real CT has been tested.
* Treat automatic results as a head start, not a measurement.

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
3. *Place the next one* walks through the landmarks; each shows what to click. Drag any point to adjust.
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
* `npm test` runs 96 unit tests (measurement geometry on both sides and with a tilted patient, detection against
  phantom truth, anonymisation, reports). `npm run e2e` drives the built site in headless Chromium (needs Playwright):
  all six study types, a DICOM file with planted identifiers, landmark placement, muscle outlines, exports, and the
  no-network guarantee.

Pushing to `main` runs the tests and publishes `dist/` to the `gh-pages` branch (Settings → Pages → Deploy from a
branch → `gh-pages` / root).

MIT licence.
