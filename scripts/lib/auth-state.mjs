// scripts/lib/auth-state.mjs
//
// Playwright session-state helper for ATS portals that require login (Workday,
// Taleo, iCIMS, Lever, LinkedIn). Greenhouse and Ashby public boards do NOT
// need this — they accept anonymous form submissions.
//
// Workflow:
//   1. First time on a Workday URL: `node scripts/apply-form.mjs <id> --login`
//      → opens browser, you log in manually, hit Enter when done
//      → script saves cookies + localStorage to .auth/{platform}.json
//   2. Subsequent runs reuse that file automatically — no password ever
//      stored in code or repo (.auth/ is gitignored).
//
// SAFETY: .auth/*.json contains session cookies — treat as credentials. Never
// commit. Rotate by re-running --login when sessions expire.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const AUTH_DIR = resolve(PROJECT_ROOT, '.auth');

const PLATFORMS_REQUIRING_AUTH = ['workday', 'taleo', 'icims', 'lever-account', 'linkedin', 'indeed', 'glassdoor'];

export function detectPlatform(url) {
  if (/myworkdayjobs\.com|wd\d+\.workday\.com|workday\.com/i.test(url)) return 'workday';
  if (/taleo\.net|tal\.net/i.test(url)) return 'taleo';
  if (/icims\.com/i.test(url)) return 'icims';
  if (/jobs\.lever\.co.*\/applications/i.test(url)) return 'lever-account';
  if (/lever\.co/i.test(url)) return 'lever';
  if (/linkedin\.com\/jobs\/(view|apply)/i.test(url)) return 'linkedin';
  if (/indeed\.com/i.test(url)) return 'indeed';
  if (/glassdoor\.com/i.test(url)) return 'glassdoor';
  if (/greenhouse\.io|grnh\.se/i.test(url)) return 'greenhouse';
  if (/ashbyhq\.com/i.test(url)) return 'ashby';
  if (/smartrecruiters\.com/i.test(url)) return 'smartrecruiters';
  return 'generic';
}

export function platformRequiresAuth(platform) {
  return PLATFORMS_REQUIRING_AUTH.includes(platform);
}

function authPath(platform) {
  return resolve(AUTH_DIR, `${platform}.json`);
}

export function hasAuthState(platform) {
  return existsSync(authPath(platform));
}

// Returns { storageState: '/path/to/.auth/{platform}.json' } if file exists,
// otherwise an empty object — pass directly into chromium.newContext(opts).
export function loadAuthOptions(platform) {
  if (!hasAuthState(platform)) return {};
  return { storageState: authPath(platform) };
}

export async function saveAuthState(context, platform) {
  if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });
  const target = authPath(platform);
  await context.storageState({ path: target });
  return target;
}

// Block the script until the user presses Enter in the terminal — used during
// `--login` so the candidate can log in manually before we save the session.
export function waitForEnter(prompt = '› Press Enter to continue (after you finish logging in): ') {
  return new Promise((resolveFn) => {
    process.stdout.write(prompt);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolveFn();
    });
  });
}

// Sanity check on a saved session — quick visual indicator for the candidate.
export function authStateSummary(platform) {
  const p = authPath(platform);
  if (!existsSync(p)) return null;
  try {
    const state = JSON.parse(readFileSync(p, 'utf-8'));
    const cookieCount = (state.cookies || []).length;
    const originCount = (state.origins || []).length;
    return { path: p, cookies: cookieCount, origins: originCount };
  } catch (_) {
    return { path: p, cookies: 0, origins: 0, broken: true };
  }
}
