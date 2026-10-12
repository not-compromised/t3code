#!/usr/bin/env node
// Picks the upstream nightly the fork rebases onto: the newest non-draft
// release whose tag is a plain nightly version. Reads the GitHub releases
// API response (newest first) on stdin, prints the tag, exits 1 when none.
"use strict";

const NIGHTLY_TAG = /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;

function selectNightly(releases) {
  const release = releases.find((r) => !r.draft && NIGHTLY_TAG.test(r.tag_name));
  return release ? release.tag_name : null;
}

module.exports = { selectNightly, NIGHTLY_TAG };

if (require.main === module) {
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const tag = selectNightly(JSON.parse(input));
    if (!tag) {
      console.error("no upstream nightly release found");
      process.exit(1);
    }
    console.log(tag);
  });
}
