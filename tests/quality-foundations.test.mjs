import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import handler from "../netlify/functions/api.mjs";

test("health endpoint returns deployment diagnostics without database access", async () => {
  const response = await handler(new Request("https://example.test/.netlify/functions/api?action=health"));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(typeof payload.appVersion, "string");
  assert.equal(typeof payload.serverNow, "string");
  assert.equal(payload.supabaseConfigured, false);
});

test("the release includes the offline shell, shared design system, and concurrency migration", async () => {
  const [serviceWorker, designSystem, migration, netlifyConfig] = await Promise.all([
    fs.readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../public/design-system.css", import.meta.url), "utf8"),
    fs.readFile(new URL("../supabase/migrations/024_quality_foundations.sql", import.meta.url), "utf8"),
    fs.readFile(new URL("../netlify.toml", import.meta.url), "utf8"),
  ]);
  assert.match(serviceWorker, /addAll\(SHELL\)/);
  assert.match(serviceWorker, /addEventListener\("fetch"/);
  assert.match(designSystem, /prefers-reduced-motion/);
  assert.match(designSystem, /safe-area-inset-bottom/);
  assert.match(migration, /add column if not exists revision/);
  assert.match(migration, /kbc_bump_revision/);
  assert.match(migration, /create table if not exists public\.push_delivery_log/i);
  assert.match(netlifyConfig, /Content-Security-Policy/);
});
