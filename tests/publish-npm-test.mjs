import { npmPublishArguments } from "../scripts/publish-npm.mjs";
assert(JSON.stringify(npmPublishArguments("3.0.0-beta.1", "prerelease")) === JSON.stringify(["publish", "--tag", "beta"]), "beta publish arguments are incorrect");
assert(JSON.stringify(npmPublishArguments("3.0.0-rc.1", "prerelease")) === JSON.stringify(["publish", "--tag", "next"]), "rc publish arguments are incorrect");
assert(JSON.stringify(npmPublishArguments("3.0.0", "stable")) === JSON.stringify(["publish", "--tag", "latest"]), "stable publish arguments are incorrect");
expectThrow(() => npmPublishArguments("3.0.0", "prerelease"), "requires a dev, beta, or rc");
expectThrow(() => npmPublishArguments("3.0.0-beta.1", "stable"), "without a prerelease suffix");
console.log("npm publication command test ok");
function expectThrow(callback, expected) { try { callback(); } catch (error) { if (String(error?.message || error).includes(expected)) return; throw error; } throw new Error(`expected throw containing: ${expected}`); }
function assert(condition, message) { if (!condition) throw new Error(message); }
