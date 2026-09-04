/** Entry point: node test/run.mjs */
import './parse.test.mjs';
import './align.test.mjs';
import './select.test.mjs';
import './urls.test.mjs';
import './position.test.mjs';
import './translate.test.mjs';
import { runAll } from './harness.mjs';

await runAll();
