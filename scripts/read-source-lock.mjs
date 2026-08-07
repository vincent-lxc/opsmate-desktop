/**
 * Task 1 — read and fail-closed-validate release/source-lock.json.
 * When run as CLI, prints GitHub Actions output lines:
 *   repository=<value>
 *   commit=<value>
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, validateSourceLock } from "./check-release-config.mjs";

export const SOURCE_LOCK_REL = "release/source-lock.json";
export const SOURCE_LOCK_PATH = resolve(ROOT, SOURCE_LOCK_REL);

/** Only these top-level keys are allowed in the lock document. */
export const ALLOWED_SOURCE_LOCK_KEYS = Object.freeze(["repository", "commit"]);

/**
 * Parse source-lock JSON text and fail closed on malformed JSON, extra keys,
 * or invalid repository/commit values.
 * @param {string} text
 * @returns {{
 *   ok: boolean,
 *   errors: string[],
 *   lock: { repository: string, commit: string } | null
 * }}
 */
export function parseSourceLockText(text) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      errors: [
        `release/source-lock.json must be valid JSON: ${
          e instanceof Error ? e.message : String(e)
        }`,
      ],
      lock: null,
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      errors: ["release/source-lock.json must be a JSON object"],
      lock: null,
    };
  }

  /** @type {Record<string, unknown>} */
  const obj = /** @type {Record<string, unknown>} */ (parsed);
  const errors = [];

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_SOURCE_LOCK_KEYS.includes(key)) {
      errors.push(
        `release/source-lock.json must not contain top-level key ${key}`,
      );
    }
  }
  for (const required of ALLOWED_SOURCE_LOCK_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(obj, required)) {
      errors.push(`release/source-lock.json missing required key ${required}`);
    }
  }

  errors.push(...validateSourceLock(obj));

  if (errors.length > 0) {
    return { ok: false, errors, lock: null };
  }

  return {
    ok: true,
    errors: [],
    lock: {
      repository: String(obj.repository),
      commit: String(obj.commit),
    },
  };
}

/**
 * Load and validate the checked-in source lock file.
 * @param {string} [path]
 * @returns {{
 *   ok: boolean,
 *   errors: string[],
 *   lock: { repository: string, commit: string } | null
 * }}
 */
export function loadSourceLock(path = SOURCE_LOCK_PATH) {
  if (!existsSync(path)) {
    return {
      ok: false,
      errors: [`missing ${SOURCE_LOCK_REL}`],
      lock: null,
    };
  }
  return parseSourceLockText(readFileSync(path, "utf8"));
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const result = loadSourceLock();
  if (!result.ok || !result.lock) {
    console.error("read-source-lock FAILED:");
    for (const e of result.errors) console.error(" -", e);
    process.exit(1);
  }
  // GitHub Actions step output (append with >> "$GITHUB_OUTPUT")
  console.log(`repository=${result.lock.repository}`);
  console.log(`commit=${result.lock.commit}`);
  process.exit(0);
}
