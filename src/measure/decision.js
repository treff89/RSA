// Anatomic versus reverse replacement for a native shoulder: a transparent, rule-based reading of published risk
// factors. It is NOT a validated prediction model — no such model exists, and comparative studies of anatomic and
// reverse replacement for cuff-intact arthritis report similar scores with trade-offs in motion and revision.
// Every factor shows its weight and source so the reasoning can be checked and overruled.
//
// Positive points favour a reverse; negative points favour an anatomic replacement.

const F = (label, points, text, refs = [], strong = false) => ({ label, points, text, refs, strong });

/**
 * input = {
 *   age, cuff: 'intact'|'partial'|'full'|'massive'|'unknown', pseudoparesis: bool, inflammatory: bool,
 *   ahd, hamada, csa, inclAp, favard,                     // AP radiograph
 *   version, versionSource: 'ct'|'xray', sublux, walch,   // CT or axillary view
 *   fat: { ss, is, ssc, tm } (fat fraction %, CT),        // muscle analysis
 * }  — every field optional.
 */
export function anatomicVsReverse(input) {
  const f = [];
  const n = (x) => Number.isFinite(x);
  const i = input || {};

  // ── cuff: the deciding question ──
  if (n(i.ahd)) {
    if (i.ahd < 6) f.push(F(`Acromiohumeral distance ${i.ahd.toFixed(1)} mm`, 5, 'Under 6 mm: static superior migration, seen only with a complete infraspinatus tear and advanced fatty infiltration. An anatomic glenoid under an uncentred head fails by eccentric loading.', ['goutallier2011', 'saupe2006'], true));
    else if (i.ahd <= 7) f.push(F(`Acromiohumeral distance ${i.ahd.toFixed(1)} mm`, 2.5, 'At or under 7 mm: the level associated with large chronic cuff tears.', ['saupe2006']));
    else f.push(F(`Acromiohumeral distance ${i.ahd.toFixed(1)} mm`, -0.5, 'Maintained: no radiographic sign of cuff failure (which does not prove an intact cuff).', ['saupe2006']));
  }
  if (i.hamada && i.hamada !== '0' && i.hamada !== '1') {
    f.push(F(`Hamada grade ${i.hamada.toUpperCase()}`, 6, 'Radiographic cuff-tear arthropathy. This is the classic indication for a reverse; an anatomic replacement is contraindicated.', ['hamada1990', 'hamada2011'], true));
  }
  if (i.cuff === 'massive') f.push(F('Massive or irreparable cuff tear', 6, 'Without a functioning cuff an anatomic replacement cannot stay centred.', [], true));
  else if (i.cuff === 'full') f.push(F('Full-thickness cuff tear', 4, 'A full-thickness tear at the time of replacement is the main reason to choose a reverse; a small repairable tear in a young patient is the exception.', [], true));
  else if (i.cuff === 'partial') f.push(F('Partial-thickness cuff tear', 1, 'A partial tear raises the risk of later cuff failure under an anatomic replacement.', []));
  else if (i.cuff === 'intact') f.push(F('Cuff intact on imaging', -2, 'An intact, working cuff is the precondition for an anatomic replacement, which gives somewhat better motion in comparative studies.', ['shah2026']));
  if (i.pseudoparesis) f.push(F('Pseudoparesis (active elevation under 90° with free passive motion)', 3, 'A functional sign of cuff failure.', [], true));

  const fat = i.fat || {};
  const worstPost = Math.max(n(fat.is) ? fat.is : -1, n(fat.ss) ? fat.ss : -1);
  if (worstPost >= 16.05) f.push(F(`Advanced fatty infiltration of the posterosuperior cuff (${worstPost.toFixed(0)}% fat)`, 4, 'Closest to Goutallier grade 3–4: the muscle cannot centre the head whatever the tendon looks like.', ['werthel2022', 'goutallier2011'], true));
  else if (worstPost >= 7.15) f.push(F(`Moderate fatty infiltration of the posterosuperior cuff (${worstPost.toFixed(0)}% fat)`, 1.5, 'Closest to Goutallier grade 2: a cuff of doubtful durability.', ['werthel2022']));
  else if (worstPost >= 0) f.push(F(`Posterosuperior cuff muscle quality preserved (${worstPost.toFixed(0)}% fat)`, -1, 'Low intramuscular fat on CT.', ['werthel2022']));
  if (n(fat.ssc) && fat.ssc >= 16.05) f.push(F(`Advanced fatty infiltration of subscapularis (${fat.ssc.toFixed(0)}% fat)`, 2, 'An anatomic replacement depends on subscapularis healing after it is taken down.', ['werthel2022']));

  // ── glenoid ──
  if (n(i.version)) {
    const src = i.versionSource === 'xray' ? ' (axillary radiograph — typically overestimates by 6°, confirm on CT)' : '';
    const w = i.versionSource === 'xray' ? 0.5 : 1;   // a radiographic version counts half
    if (i.version <= -25) f.push(F(`Glenoid retroversion ${Math.abs(i.version).toFixed(0)}°${src}`, 3 * w, 'Beyond about 25° an anatomic component needs an augment or graft, and the largest biconcave series is quoted as finding loosening or instability in over 40% above 27°. Reverse arthroplasty for biconcave glenoids gave good scores without recurrent posterior instability.', ['walch2012', 'mizuno2013', 'nyffeler2003']));
    else if (i.version <= -15) f.push(F(`Glenoid retroversion ${Math.abs(i.version).toFixed(0)}°${src}`, 1.5 * w, 'At 15° or more, a component left retroverted carried five times the odds of osteolysis; both corrected anatomic and reverse replacement are used here.', ['ho2013', 'bercik2016']));
    else f.push(F(`Glenoid version ${i.version.toFixed(0)}°${src}`, -0.5 * w, 'No retroversion that would complicate an anatomic glenoid.', ['friedman1992']));
  }
  if (n(i.sublux)) {
    if (i.sublux > 80) f.push(F(`Posterior subluxation ${i.sublux.toFixed(0)}%`, 2, 'Severe static posterior subluxation: the setting in which most posterior dislocations after anatomic replacement were reported.', ['walch2012']));
    else if (i.sublux >= 70) f.push(F(`Posterior subluxation ${i.sublux.toFixed(0)}%`, 1, 'Marked static posterior subluxation (a B3 criterion).', ['bercik2016']));
  }
  if (i.walch) {
    const w = { A1: -0.5, A2: 0, B1: 0.5, B2: 1.5, B3: 2.5, C: 2.5, D: 0.5 }[i.walch];
    if (w !== undefined && w !== 0) f.push(F(`Walch type ${i.walch}`, w, w > 0
      ? 'Eccentric or dysplastic glenoid: more glenoid complications after anatomic replacement than in type A.'
      : 'Concentric glenoid: the favourable setting for an anatomic replacement.', ['bercik2016', 'walch2012']));
  }
  if (n(i.inclAp) && i.inclAp >= 20) f.push(F(`Superior glenoid tilt ${i.inclAp.toFixed(0)}°`, 2, 'Marked superior inclination means superior wear, the coronal signature of cuff insufficiency.', ['boileau2019']));
  if (i.favard === 'E2' || i.favard === 'E3') f.push(F(`Favard ${i.favard} superior erosion`, 2.5, 'Superior glenoid erosion is caused by a superiorly migrated head.', ['favard2004'], true));
  if (n(i.csa) && i.csa > 35) f.push(F(`Critical shoulder angle ${i.csa.toFixed(0)}°`, 1, 'Above 35°: associated with cuff tears, and with at-risk glenoid components after anatomic replacement (odds ×1.2 per degree).', ['moor2013', 'watling2018']));
  else if (n(i.csa) && i.csa < 30) f.push(F(`Critical shoulder angle ${i.csa.toFixed(0)}°`, -0.5, 'Below 30°: the osteoarthritic pattern, in which the cuff is usually intact.', ['moor2013']));

  // ── patient ──
  if (n(i.age)) {
    if (i.age >= 75) f.push(F(`Age ${i.age}`, 1.5, 'Over 70, reverse replacement had about half the revision risk of anatomic, at the cost of a lower function score; other series found no age-based benefit.', ['dragonas2023', 'poondla2021']));
    else if (i.age >= 70) f.push(F(`Age ${i.age}`, 1, 'Over 70, reverse replacement had about half the revision risk of anatomic, at the cost of a lower function score; other series found no age-based benefit.', ['dragonas2023', 'poondla2021']));
    else if (i.age < 55) f.push(F(`Age ${i.age}`, -2, 'A young patient will outlive the implant: preserving bone and motion argues for an anatomic replacement — or a hemiarthroplasty — where the cuff allows.', ['shah2026']));
    else if (i.age < 65) f.push(F(`Age ${i.age}`, -1, 'Under 65: longevity and revision options weigh towards an anatomic replacement where the cuff allows.', ['shah2026']));
  }
  if (i.inflammatory) f.push(F('Inflammatory arthritis', 1, 'The cuff and glenoid bone are at risk over time.', []));

  const score = f.reduce((s, x) => s + x.points, 0);
  const strong = f.filter((x) => x.strong && x.points > 0);
  const cuffKnown = i.cuff && i.cuff !== 'unknown';
  const hasMuscle = worstPost >= 0;
  const hasAnything = f.length > 0;

  let verdict, status, headline;
  if (!hasAnything) {
    verdict = 'insufficient'; status = 'pending';
    headline = 'Not enough has been measured to say anything.';
  } else if (strong.length || score >= 5) {
    verdict = 'reverse'; status = 'out';
    headline = 'The findings favour a reverse replacement.';
  } else if (score >= 2) {
    verdict = 'lean-reverse'; status = 'borderline';
    headline = 'Grey zone, leaning towards a reverse replacement.';
  } else if (score > -1.5 || (!cuffKnown && !hasMuscle)) {
    verdict = 'grey'; status = 'borderline';
    headline = !cuffKnown && !hasMuscle && score <= -1.5
      ? 'Nothing on these images argues against an anatomic replacement — but the cuff has not been assessed.'
      : 'Grey zone: the images do not favour either implant.';
  } else {
    verdict = 'anatomic'; status = 'good';
    headline = 'The findings favour an anatomic replacement.';
  }

  const caveats = [
    'This is a weighted checklist of published risk factors, with weights chosen by judgement. It has not been validated against outcomes and is not a prediction.',
    'Comparative studies of anatomic and reverse replacement for arthritis with an intact cuff report similar patient-reported scores: anatomic tends to give more motion, reverse fewer revisions. No age, glenoid type or fatty-infiltration threshold has been validated for the choice.',
  ];
  if (!cuffKnown && !hasMuscle) caveats.push('The single most important input — the state of the rotator cuff — is unknown. A radiograph only shows cuff failure late (superior migration). Get an ultrasound, MRI or CT arthrogram before relying on any leaning towards an anatomic replacement.');
  if (i.versionSource === 'xray') caveats.push('Glenoid version came from an axillary radiograph, which overestimates retroversion in most shoulders. Plan the glenoid from CT.');
  if (!n(i.version) && !i.walch) caveats.push('Glenoid version and type are not known. They decide whether an anatomic glenoid can be seated at all.');

  return {
    verdict, status, headline, score,
    factors: f.sort((a, b) => Math.abs(b.points) - Math.abs(a.points)),
    caveats,
  };
}
