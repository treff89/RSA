// Allows `node --test test/dicom` on Node 22 (which resolves a directory argument to its index.js).
// A `node --test "test/**/*.test.js"` glob also finds the *.test.js files directly.
import './loader.test.js';
import './radiograph.test.js';
import './intake.test.js';
