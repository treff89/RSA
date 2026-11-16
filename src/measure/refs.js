// Literature behind every reference band and statement in the app.
//
// `v` records how each entry was checked while this tool was written:
//   'C'  the figures used were confirmed against the paper's abstract or full text
//   'S'  the figures used are quoted second-hand (seen in another paper or review, not in the source itself)
//   'U'  cited from general knowledge of the literature; not re-checked — verify before relying on it
// The app shows this flag next to each citation.

const R = (cite, doi, v, note) => ({ cite, doi: doi || '', v, note: note || '' });

export const REFS = {
  // ── reverse arthroplasty: lateralisation / distalisation ──
  boutsiadis2018: R('Boutsiadis A, Lenoir H, Denard PJ, et al. The lateralization and distalization shoulder angles are important determinants of clinical outcomes in reverse shoulder arthroplasty. J Shoulder Elbow Surg 2018;27:1226–34.', '10.1016/j.jse.2018.02.036', 'C', '46 shoulders; LSA 75–95° and DSA 40–65° associated with better active motion.'),
  imiolczyk2024: R('Imiolczyk JP, et al. J Shoulder Elbow Surg 2024;33:121.', '10.1016/j.jse.2023.05.031', 'C', '630 shoulders; mean LSA 78°, DSA 51°; neither angle predicted outcome.'),
  erickson2022: R('Erickson BJ, et al. J Shoulder Elbow Surg 2022;31:963.', '10.1016/j.jse.2021.10.010', 'C', '203 shoulders with 135° stems; only LSA weakly associated with outcome.'),
  sahin2025: R('Sahin K, et al. Lateralization and distalization shoulder angles in reverse shoulder arthroplasty: are they still reliable and accurate in all patients and for all prosthetic designs? J Clin Med 2025;14:1393.', '10.3390/jcm14041393', 'C', '135 shoulders; LSA 88 ± 12°, DSA 41 ± 13°; 57% and 44% inside the published bands.'),
  okutan2024: R('Okutan AE, et al. Arch Orthop Trauma Surg 2024.', '10.1007/s00402-024-05448-6', 'C', 'CT validation: LSA vs true lateralisation r = 0.36; DSA vs distalisation r = 0.17.'),
  jobin2012: R('Jobin CM, Brown GD, Bahu MJ, et al. Reverse total shoulder arthroplasty for cuff tear arthropathy: the clinical effect of deltoid lengthening and center of rotation medialization. J Shoulder Elbow Surg 2012;21:1269–77.', '10.1016/j.jse.2011.08.049', 'C', 'Acromion–tuberosity distance > 38 mm predicted ≥ 135° active elevation (PPV 90%).'),
  ladermann2012: R('Lädermann A, Walch G, Lubbeke A, et al. Influence of arm lengthening in reverse shoulder arthroplasty. J Shoulder Elbow Surg 2012;21:336–41.', '10.1016/j.jse.2011.04.020', 'C', '183 shoulders; shortened arms elevated less.'),
  ladermann2014: R('Lädermann A, Edwards TB, Walch G. Arm lengthening after reverse shoulder arthroplasty: a review. Int Orthop 2014;38:991–1000.', '10.1007/s00264-013-2175-z', 'C', 'Mean post-operative acromiohumeral distance 23 mm; 0–2 cm of lengthening a reasonable goal.'),
  otto2013: R('Otto RJ, Virani NA, Levy JC, et al. Scapular fractures after reverse shoulder arthroplasty. J Shoulder Elbow Surg 2013;22:1514–21.', '10.1016/j.jse.2013.02.007', 'C', 'Acromion–tuberosity distance changed more in fracture cases than in controls.'),
  werthel2019: R('Werthel JD, Walch G, Vegehan E, et al. Lateralization in reverse shoulder arthroplasty: a descriptive analysis of different implants in current practice. Int Orthop 2019;43:2349–60.', '10.1007/s00264-019-04365-3', 'C', 'Global lateral offset of 22 implant designs, from 13 mm (Delta III) upward.'),
  // ── reverse arthroplasty: glenoid component ──
  boileau2019: R('Boileau P, Gauci MO, Wagner ER, et al. The reverse shoulder arthroplasty angle: a new measurement of glenoid inclination for reverse shoulder arthroplasty. J Shoulder Elbow Surg 2019;28:1281–90.', '10.1016/j.jse.2018.11.074', 'C', 'RSA angle 20–25°; about 10° more than the whole-glenoid (β) inclination.'),
  maurer2012: R('Maurer A, Fucentese SF, Pfirrmann CWA, et al. Assessment of glenoid inclination on routine clinical radiographs and computed tomography examinations of the shoulder. J Shoulder Elbow Surg 2012;21:1096–103.', '10.1016/j.jse.2011.07.010', 'C', 'β-angle: most reproducible inclination measure on AP films.'),
  levigne2011: R('Lévigne C, Garret J, Boileau P, et al. Scapular notching in reverse shoulder arthroplasty: is it important to avoid it and how? Clin Orthop Relat Res 2011.', '10.1007/s11999-010-1695-8', 'C', '461 shoulders; avoid superior tilt and cranial position; aim for inferior overhang.'),
  tashjian2018: R('Tashjian RZ, Martin BI, Ricketts CA, et al. Superior baseplate inclination is associated with instability after reverse total shoulder arthroplasty. Clin Orthop Relat Res 2018;476:1622–9.', '10.1097/CORR.0000000000000340', 'C', '97 shoulders; baseplate inclination associated with instability; no cut-off given.'),
  bechtold2021: R('Bechtold DA, et al. J Shoulder Elbow Surg 2021;30:e370.', '10.1016/j.jse.2020.09.037', 'C', 'Case-control; glenoid inclination did not influence stability.'),
  patel2021: R('Patel M, et al. J Shoulder Elbow Surg 2021;30:1273.', '10.1016/j.jse.2020.09.023', 'C', 'Simulation: 10° of inferior tilt increased inferior impingement.'),
  collotte2021: R('Collotte P, Bercik M, Vieira TD, Walch G. Long-term reverse total shoulder arthroplasty outcomes: the effect of the inferior shifting of glenoid component fixation. Clin Orthop Surg 2021;13:505–12.', '10.4055/cios20245', 'C', '≥ 3.5 mm overhang: notching 37% vs 82.5% (155° Grammont, mean 8 years).'),
  dewilde2010: R('de Wilde LF, Poncet D, Middernacht B, Ekelund A. Prosthetic overhang is the most effective way to prevent scapular conflict in a reverse total shoulder prosthesis. Acta Orthop 2010;81:719–26.', '10.3109/17453674.2010.538354', 'C'),
  nyffeler2005: R('Nyffeler RW, Werner CML, Gerber C. Biomechanical relevance of glenoid component positioning in the reverse Delta III total shoulder prosthesis. J Shoulder Elbow Surg 2005;14:524–8.', '10.1016/j.jse.2004.09.010', 'C'),
  simovitch2007: R('Simovitch RW, Zumstein MA, Lohri E, et al. Predictors of scapular notching in patients managed with the Delta III reverse total shoulder replacement. J Bone Joint Surg Am 2007;89:588–600.', '10.2106/JBJS.F.00226', 'C'),
  sirveaux2004: R('Sirveaux F, Favard L, Oudet D, et al. Grammont inverted total shoulder arthroplasty in the treatment of glenohumeral osteoarthritis with massive rupture of the cuff. J Bone Joint Surg Br 2004;86:388–95.', '10.1302/0301-620X.86B3.14024', 'S', 'Notching grades as quoted by Lévigne 2011.'),
  // ── humeral stem ──
  kramer2024: R('Kramer M, Olach M, Zdravkovic V, et al. Arch Orthop Trauma Surg 2024;144:663–72.', '10.1007/s00402-023-05129-w', 'C', 'Uncemented reverse stems; filling-ratio cut-off 0.7 for stress shielding.'),
  schnetzke2016: R('Schnetzke M, Coda S, Raiss P, et al. Radiologic bone adaptations on a cementless short-stem shoulder prosthesis. J Shoulder Elbow Surg 2016;25:650–7.', '10.1016/j.jse.2015.08.044', 'C'),
  raiss2019: R('Raiss P, Schnetzke M, Wittmann T, et al. Postoperative radiographic findings of an uncemented convertible short stem for anatomic and reverse shoulder arthroplasty. J Shoulder Elbow Surg 2019;28:715–23.', '10.1016/j.jse.2018.08.037', 'C'),
  abdic2021: R('Abdic S, et al. Arch Orthop Trauma Surg 2021;141:183.', '10.1007/s00402-020-03424-4', 'C', 'Neutral stem alignment defined as within ±5° of the humeral axis.'),
  sperling2000: R('Sperling JW, Cofield RH, O\'Driscoll SW, et al. Radiographic assessment of ingrowth total shoulder arthroplasty. J Shoulder Elbow Surg 2000;9:507–13.', '10.1067/mse.2000.109384', 'U', '"At risk" humeral component: lucent lines ≥ 2 mm in ≥ 3 zones.'),
  sanchezsotelo2001: R('Sanchez-Sotelo J, O\'Driscoll SW, Torchia ME, et al. Radiographic assessment of cemented humeral components in shoulder arthroplasty. J Shoulder Elbow Surg 2001;10:526–31.', '10.1067/mse.2001.118482', 'U'),
  levy2013: R('Levy JC, Anderson C, Samson A. Classification of postoperative acromial fractures following reverse shoulder arthroplasty. J Bone Joint Surg Am 2013;95:e104.', '10.2106/JBJS.K.01516', 'C'),
  crosby2011: R('Crosby LA, Hamilton A, Twiss T. Scapula fractures after reverse total shoulder arthroplasty: classification and treatment. Clin Orthop Relat Res 2011;469:2544–9.', '10.1007/s11999-011-1881-3', 'C'),
  // ── hemiarthroplasty / overstuffing ──
  alolabi2014: R('Alolabi B, Youderian AR, Napolitano L, et al. Radiographic assessment of prosthetic humeral head size after anatomic shoulder arthroplasty. J Shoulder Elbow Surg 2014;23:1740–6.', '10.1016/j.jse.2014.02.013', 'C', 'Best-fit circle; centre-of-rotation deviation > 3 mm defined as a significant outlier.'),
  youderian2014: R('Youderian AR, Ricchetti ET, Drews M, Iannotti JP. Determination of humeral head size in anatomic shoulder replacement for glenohumeral osteoarthritis. J Shoulder Elbow Surg 2014;23:955–63.', '', 'C', 'Circle through preserved landmarks predicts head radius within 0.5 mm.'),
  cointat2022: R('Cointat C, Raynier JL, Vasseur H, et al. Short-term outcomes and survival of pyrocarbon hemiarthroplasty in the young arthritic shoulder. J Shoulder Elbow Surg 2022;31:113–22.', '10.1016/j.jse.2021.06.002', 'C', 'Centre of rotation > 3 mm from anatomic in 29%, with worse function and more revisions.'),
  boileau2026: R('Boileau P, et al. J Shoulder Elbow Surg 2026;35:421.', '10.1016/j.jse.2025.06.021', 'C', 'Pyrocarbon hemiarthroplasty: oversizing in 24%; erosion OR 3.46; revision 25% vs 1.3%.'),
  geervliet2019: R('Geervliet PC, et al. J Orthop Surg Res 2019;14:474.', '10.1186/s13018-019-1522-1', 'C', 'Resurfacing: revision cut-off 5.8 mm of centre-of-rotation deviation.'),
  sandau2018: R('Sandau N, et al. Low inter-observer agreement among experienced shoulder surgeons assessing overstuffing of glenohumeral resurfacing hemiarthroplasty. J Orthop Surg Res 2018;13:299.', '10.1186/s13018-018-1008-6', 'C', 'Kappa 0.24–0.28.'),
  iannotti1992: R('Iannotti JP, Gabriel JP, Schneck SL, et al. The normal glenohumeral relationships: an anatomical study of one hundred and forty shoulders. J Bone Joint Surg Am 1992;74:491–500.', '', 'C', 'Head radius 24 ± 2.1 mm; head 8 ± 3.2 mm above the greater tuberosity; lateral humeral offset 56 ± 5.7 mm.'),
  nyffeler2004: R('Nyffeler RW, Sheikh R, Jacob HAC, Gerber C. Influence of humeral prosthesis height on biomechanics of glenohumeral abduction. J Bone Joint Surg Am 2004;86:575–80.', '', 'C', '5 mm too high: −10° abduction; 10 mm: −16°.'),
  harryman1995: R('Harryman DT, Sidles JA, Harris SL, et al. The effect of articular conformity and the size of the humeral head component on laxity and motion after glenohumeral arthroplasty. J Bone Joint Surg Am 1995;77:555–63.', '', 'C', 'An oversized head reduces motion; no millimetre threshold.'),
  boileau1997: R('Boileau P, Walch G. The three-dimensional geometry of the proximal humerus: implications for surgical technique and prosthetic design. J Bone Joint Surg Br 1997;79:857–65.', '', 'U', 'Medial offset of the head centre about 7 mm.'),
  garret2019: R('Garret J, Harly E, Le Huec JC, et al. Pyrocarbon humeral head in a hemi-shoulder arthroplasty: preliminary results at 2-year follow-up. JSES Open Access 2019;3:37–42.', '', 'C'),
  garret2024: R('Garret J, et al. J Shoulder Elbow Surg 2024;33:328.', '10.1016/j.jse.2023.06.021', 'C', 'Pyrocarbon hemiarthroplasty at 6 years: erosion moderate 24%, severe 8%; revision 4.4%.'),
  pycReview2023: R('Systematic review and meta-analysis of pyrocarbon shoulder hemiarthroplasty, 2023 (8 studies, 536 shoulders).', '', 'S', 'Glenoid erosion 23%, tuberosity thinning 10%, change of implant position 10%.'),
  schippers2026: R('Schippers P, et al. JSES Int 2026;10:101655.', '10.1016/j.jseint.2026.101655', 'C', 'Glenoid erosion measured as medialisation relative to shaft diameter (ICC 0.96).'),
  griswold2025: R('Griswold BG, et al. J Bone Joint Surg Am 2025;107:2751.', '', 'C', 'Medialisation after hemiarthroplasty.'),
  sperling2004: R('Sperling JW, Cofield RH, Rowland CM. Minimum fifteen-year follow-up of Neer hemiarthroplasty and total shoulder arthroplasty in patients aged fifty years or younger. J Shoulder Elbow Surg 2004;13:604–13.', '', 'S', 'Erosion grading none / mild / moderate / severe; wording here is paraphrased, not verified.'),
  // ── native shoulder ──
  moor2013: R('Moor BK, Bouaicha S, Rothenfluh DA, et al. Is there an association between the individual anatomy of the scapula and the development of rotator cuff tears or osteoarthritis of the glenohumeral joint? Bone Joint J 2013;95-B:935–41.', '', 'C', 'CSA: controls 33°, cuff tears 38°, osteoarthritis 28°.'),
  watling2018: R('Watling JP, Sanchez JE, Heilbroner SP, et al. Glenoid component loosening associated with increased critical shoulder angle at midterm follow-up. J Shoulder Elbow Surg 2018;27:449–54.', '10.1016/j.jse.2017.10.002', 'C', 'Odds of an at-risk glenoid ×1.20 per degree of CSA.'),
  nyffeler2006: R('Nyffeler RW, Werner CML, Sukthankar A, et al. Association of a large lateral extension of the acromion with rotator cuff tears. J Bone Joint Surg Am 2006;88:800–5.', '', 'C', 'Acromion index 0.73 / 0.64 / 0.60.'),
  saupe2006: R('Saupe N, Pfirrmann CWA, Schmid MR, et al. Association between rotator cuff abnormalities and reduced acromiohumeral distance. AJR Am J Roentgenol 2006;187:376–82.', '', 'C', 'Acromiohumeral distance ≤ 7 mm.'),
  goutallier2011: R('Goutallier D, Le Guilloux P, Postel JM, et al. Acromio humeral distance less than six millimeter: its meaning in full-thickness rotator cuff tear. Orthop Traumatol Surg Res 2011;97:246–51.', '', 'C'),
  hamada1990: R('Hamada K, Fukuda H, Mikasa M, Kobayashi Y. Roentgenographic findings in massive rotator cuff tears: a long-term observation. Clin Orthop Relat Res 1990;254:92–6.', '', 'S', 'Grade definitions as commonly quoted.'),
  hamada2011: R('Hamada K, Yamanaka K, Uchiyama Y, et al. A radiographic classification of massive rotator cuff tear arthritis. Clin Orthop Relat Res 2011;469:2452–60.', '', 'S', 'Grade 4 split into 4A and 4B.'),
  favard2004: R('Favard L, Lévigne C, Nerot C, et al. Reverse prostheses in arthropathies with cuff tear: are survivorship and function maintained over time? Clin Orthop Relat Res 2011;469:2469–75.', '', 'S', 'E0–E4 coronal erosion types as commonly quoted.'),
  samilson1983: R('Samilson RL, Prieto V. Dislocation arthropathy of the shoulder. J Bone Joint Surg Am 1983;65:456–60.', '', 'U', 'Osteophyte < 3 mm, 3–7 mm, > 7 mm.'),
  spross2015: R('Spross C, Kaestle N, Benninger E, et al. Deltoid tuberosity index: a simple radiographic tool to assess local bone quality in proximal humerus fractures. Clin Orthop Relat Res 2015;473:3038–45.', '10.1007/s11999-015-4322-x', 'C', 'Cut-off 1.44.'),
  walch1999: R('Walch G, Badet R, Boulahia A, Khoury A. Morphologic study of the glenoid in primary glenohumeral osteoarthritis. J Arthroplasty 1999;14:756–60.', '', 'U'),
  bercik2016: R('Bercik MJ, Kruse K, Yalizis M, et al. A modification to the Walch classification of the glenoid in primary glenohumeral osteoarthritis using three-dimensional imaging. J Shoulder Elbow Surg 2016;25:1601–6.', '10.1016/j.jse.2016.03.010', 'C', 'B3: retroversion ≥ 15° or subluxation ≥ 70%.'),
  walch2012: R('Walch G, Moraga C, Young A, Castellanos-Rosas J. Results of anatomic nonconstrained prosthesis in primary osteoarthritis with biconcave glenoid. J Shoulder Elbow Surg 2012;21:1526–33.', '', 'S', '92 shoulders, 16% revised; the ">27°" and ">80%" figures are quoted second-hand.'),
  ho2013: R('Ho JC, Sabesan VJ, Iannotti JP. Glenoid component retroversion is associated with osteolysis. J Bone Joint Surg Am 2013;95:e82.', '10.2106/JBJS.L.00336', 'C', 'Post-operative component retroversion ≥ 15°: OR 5.2 for osteolysis.'),
  friedman1992: R('Friedman RJ, Hawthorne KB, Genez BM. The use of computerized tomography in the measurement of glenoid version. J Bone Joint Surg Am 1992;74:1032–7.', '', 'C', 'Controls about 2° anteversion; arthritic shoulders 11° retroversion.'),
  nyffeler2003: R('Nyffeler RW, Jost B, Pfirrmann CWA, Gerber C. Measurement of glenoid version: conventional radiographs versus computed tomography scans. J Shoulder Elbow Surg 2003;12:493–6.', '', 'C', 'Radiographs overestimated retroversion in 86%; mean error 6.5°.'),
  budge2011: R('Budge MD, Lewis GS, Schaefer E, et al. Comparison of standard two-dimensional and three-dimensional corrected glenoid version measurements. J Shoulder Elbow Surg 2011;20:577–83.', '', 'C'),
  // ── anatomic versus reverse ──
  shah2026: R('Shah A, et al. Bone Jt Open 2026;7:1056.', '', 'C', 'Systematic review, intact cuff: anatomic gives better motion; complications and revisions not different.'),
  vij2024: R('Vij N, et al. Cureus 2024;16:e57866.', '', 'C', 'Revision 8.8% (anatomic) vs 0.9% (reverse); cohorts differ in age.'),
  dragonas2023: R('Dragonas CG, et al. 2023 (PMID 37808225).', '', 'C', 'Over 70 years: fewer revisions with reverse (OR 0.50), better Constant score with anatomic.'),
  poondla2021: R('Poondla RK, et al. J Shoulder Elbow Surg 2021;30:1336.', '', 'C', 'No age-based benefit of reverse for osteoarthritis with an intact cuff.'),
  mizuno2013: R('Mizuno N, Denard PJ, Raiss P, Walch G. Reverse total shoulder arthroplasty for primary glenohumeral osteoarthritis in patients with a biconcave glenoid. J Bone Joint Surg Am 2013;95:1297–304.', '', 'C'),
  // ── muscle ──
  aubrey2014: R('Aubrey J, Esfandiari N, Baracos VE, et al. Measurement of skeletal muscle radiation attenuation and basis of its biological variation. Acta Physiol 2014;210:489–97.', '10.1111/apha.12224', 'C', 'Fat −190 to −30 HU; low-attenuation muscle −29 to +29; normal muscle +30 to +150.'),
  terrier2017: R('Terrier A, Ston J, Dewarrat A, et al. A semi-automated quantitative CT method for measuring rotator cuff muscle degeneration in shoulders with primary osteoarthritis. Orthop Traumatol Surg Res 2017;103:151–7.', '10.1016/j.otsr.2016.12.006', 'C', 'Y-view through the spinoglenoid notch; muscle −29 to +166 HU; atrophy, infiltration and degeneration ratios.'),
  taghizadeh2021: R('Taghizadeh E, Truffer O, Becce F, et al. Deep learning for the rapid automatic quantification and characterization of rotator cuff muscle degeneration from shoulder CT datasets. Eur Radiol 2021;31:181–90.', '10.1007/s00330-020-07070-7', 'C', 'No code or weights published.'),
  werthel2022: R('Werthel JD, Boux de Casson F, Walch G, et al. Three-dimensional muscle loss assessment: a novel computed tomography-based quantitative method to evaluate rotator cuff muscle fatty infiltration. J Shoulder Elbow Surg 2022;31:165–74.', '10.1016/j.jse.2021.07.029', 'C', 'Mean 3D fat fraction by Goutallier grade: 0.9 / 2.9 / 11.4 / 20.7 / 29.3%.'),
  goutallier1994: R('Goutallier D, Postel JM, Bernageau J, et al. Fatty muscle degeneration in cuff ruptures: pre- and postoperative evaluation by CT scan. Clin Orthop Relat Res 1994;304:78–83.', '', 'S'),
  thomazeau1996: R('Thomazeau H, Rolland Y, Lucas C, et al. Atrophy of the supraspinatus belly: assessment by MRI in 55 patients with rotator cuff pathology. Acta Orthop Scand 1996;67:264–8.', '', 'C', 'Occupation ratio 0.70 controls, 0.62 degenerative cuffs, 0.44 tears; stage limits 0.6 / 0.4 are commonly quoted but were not verified.'),
  simovitch2007tm: R('Simovitch RW, Helmy N, Zumstein MA, Gerber C. Impact of fatty infiltration of the teres minor muscle on the outcome of reverse total shoulder arthroplasty. J Bone Joint Surg Am 2007;89:934–9.', '10.2106/JBJS.F.01075', 'C', 'Teres minor grade 3–4: external rotation −7° vs +9°.'),
  wiater2015: R('Wiater BP, Koueiter DM, Maerz T, et al. Preoperative deltoid size and fatty infiltration of the deltoid and rotator cuff correlate to outcomes after reverse total shoulder arthroplasty. Clin Orthop Relat Res 2015;473:663–73.', '10.1007/s11999-014-4047-2', 'C'),
};

export const VERIFY_LABEL = {
  C: 'checked against the paper',
  S: 'quoted second-hand',
  U: 'from memory — verify',
};

export function refList(keys) {
  return [...new Set(keys)].filter((k) => REFS[k]).map((k) => ({ key: k, ...REFS[k] }));
}
