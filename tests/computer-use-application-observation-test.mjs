import assert from "node:assert/strict";
import { applicationElementSupportsPointClick, applicationMatchesSelector, prepareApplicationObservationElements } from "../src/local/computer-use-application-observation.mjs";
import { buildContinuation, observationDiff } from "../src/local/computer-use-observation.mjs";

focusQueryPromotesRelevantControlAndLocalizesGeometry();
queryMissReportsWhetherSearchWasExhaustive();
duplicateIdentityBindingsPreserveSourceOccurrenceAfterRanking();
unaddressableElementsRemainObservableButNotBound();
coercibleAccessibilityEvidenceCannotBecomeAuthority();
pointClickEquivalenceExcludesCoordinateSensitiveControls();
windowOwnershipPreventsSiblingWindowGeometryLeakage();
missingProcessIdentityCannotMapApplicationContinuation();
coercibleProcessIdentityCannotAuthorizeApplicationContinuity();
console.log("application Computer Use observation test ok");

function focusQueryPromotesRelevantControlAndLocalizesGeometry() {
  const result = prepareApplicationObservationElements([
    appElement({ index: 0, role: "AXButton", name: "Menu", screen_box: { x: 110, y: 220, width: 40, height: 20 } }),
    appElement({ index: 1, role: "AXButton", name: "Save changes", screen_box: { x: 300, y: 260, width: 100, height: 30 } }),
  ], {
    maxElements: 1,
    focusQuery: "Save changes",
    windowBounds: { x: 100, y: 200, width: 500, height: 400 },
  });
  assert.equal(result.elements.length, 1);
  assert.equal(result.elements[0].ref, "a0");
  assert.equal(result.elements[0].name, "Save changes");
  assert.equal(result.elements[0].visible, true);
  assert.deepEqual(result.elements[0].bounding_box, { x: 200, y: 60, width: 100, height: 30 });
  assert.equal(Object.hasOwn(result.elements[0], "screen_box"), false, "public Computer Use element leaked global screen coordinates");
  assert.equal(result.selection.focus_query, "save changes");
  assert.equal(result.selection.geometry_source, "window_local_accessibility");
  assert.equal(result.selection.query_matched, true);
  assert.equal(result.selection.query_match_count, 1);
  assert.equal(result.selection.query_search_exhaustive, true);
  assert(result.selection.top_query_score > 0);
  assert.equal(result.truncated, true);
}

function queryMissReportsWhetherSearchWasExhaustive() {
  const exhaustive = prepareApplicationObservationElements([appElement({ name: "Cancel" })], {
    maxElements: 1, focusQuery: "Save", sourceTruncated: false,
  });
  assert.equal(exhaustive.selection.query_matched, false);
  assert.equal(exhaustive.selection.query_match_count, 0);
  assert.equal(exhaustive.selection.query_search_exhaustive, true);

  const boundedMiss = prepareApplicationObservationElements([appElement({ name: "Cancel" })], {
    maxElements: 1, focusQuery: "Save", sourceTruncated: true,
  });
  assert.equal(boundedMiss.selection.query_matched, false);
  assert.equal(boundedMiss.selection.query_search_exhaustive, false, "truncated AX scan falsely claimed the query was exhaustively absent");
}

function duplicateIdentityBindingsPreserveSourceOccurrenceAfterRanking() {
  const result = prepareApplicationObservationElements([
    appElement({ index: 0, role: "AXButton", name: "Row", focused: false }),
    appElement({ index: 1, role: "AXButton", name: "Row", focused: true }),
  ], { maxElements: 2 });
  assert.equal(result.elements[0].focused, true, "focused duplicate was not promoted by salience");
  assert.equal(result.bindings.get("a0").occurrence, 1, "ranked duplicate lost its source identity occurrence");
  assert.equal(result.bindings.get("a0").source_index, 1);
  assert.equal(result.bindings.get("a1").occurrence, 0);
  assert.deepEqual(result.bindings.get("a0").selector, { role: "AXButton", name: "Row" });
  assert.equal(result.elements[0].visible, null, "missing window geometry was misreported as invisible instead of unknown");
}

function unaddressableElementsRemainObservableButNotBound() {
  const result = prepareApplicationObservationElements([
    appElement({ index: 0, role: "", name: "", title: "", description: "", identifier: "" }),
  ], { maxElements: 1 });
  assert.equal(result.elements.length, 1);
  assert.equal(result.bindings.has("a0"), false, "unaddressable AX element unexpectedly received an action binding");
  assert.equal(result.elements[0].visible, null, "missing geometry was treated as definite invisibility");
}

function coercibleAccessibilityEvidenceCannotBecomeAuthority() {
  const result = prepareApplicationObservationElements([
    appElement({
      role: ["AXButton"], name: "Save", enabled: "true",
      screen_box: { x: "110", y: 220, width: 40, height: 20 },
      window_screen_box: { x: 100, y: 200, width: 500, height: 400 },
    }),
    appElement({ role: "AXButton", name: ["Save"] }),
  ], {
    maxElements: 2, focusQuery: ["Save"], windowBounds: { x: 100, y: 200, width: 500, height: 400 },
  });
  assert.equal(result.bindings.has("a0"), false, "coercible AX role became private selector authority");
  assert.equal(result.bindings.has("a1"), false, "coercible AX name broadened into private selector authority");
  assert.equal(result.elements[0].bounding_box, null, "string geometry was localized into snapshot point authority");
  assert.equal(result.selection.focus_query, "", "coercible focus query became ranking evidence");
  assert.equal(applicationElementSupportsPointClick({ role: ["AXButton"], enabled: true }), false,
    "coercible AX role authorized semantic point delivery");
  assert.equal(applicationElementSupportsPointClick({ role: "AXButton", enabled: "true" }), false,
    "coercible enabled state authorized semantic point delivery");
  assert.equal(applicationMatchesSelector({ identifier: ["save"] }, { identifier: "save" }), false,
    "coercible live AX identity matched a snapshot selector");
  assert.equal(applicationMatchesSelector({ identifier: "save" }, { identifier: ["save"] }), false,
    "coercible snapshot selector matched live AX identity");

  const invalidLimit = prepareApplicationObservationElements([appElement({ name: "A" }), appElement({ name: "B" })], { maxElements: "1" });
  assert.equal(invalidLimit.elements.length, 2, "coercible maxElements silently changed the observation budget");
}

function pointClickEquivalenceExcludesCoordinateSensitiveControls() {
  for (const role of ["AXButton", "AXCheckBox", "AXRadioButton", "AXLink", "AXMenuItem", "AXPopUpButton", "AXDisclosureTriangle"]) {
    assert.equal(applicationElementSupportsPointClick(appElement({ role })), true, `${role} lost discrete semantic point delivery`);
  }
  for (const role of ["AXTextField", "AXTextArea", "AXSearchField", "AXSlider", "AXIncrementor", "AXComboBox"]) {
    assert.equal(applicationElementSupportsPointClick(appElement({ role })), false, `${role} incorrectly collapsed coordinate-sensitive point semantics into AXPress`);
  }
  assert.equal(applicationElementSupportsPointClick(appElement({ role: "AXButton", enabled: false })), false, "disabled button was treated as an actionable semantic point target");
}

function windowOwnershipPreventsSiblingWindowGeometryLeakage() {
  const capturedWindow = { x: 100, y: 200, width: 500, height: 400 };
  const result = prepareApplicationObservationElements([
    appElement({
      index: 0,
      name: "Captured window button",
      screen_box: { x: 140, y: 240, width: 120, height: 40 },
      window_screen_box: { ...capturedWindow },
    }),
    appElement({
      index: 1,
      name: "Sibling overlap",
      screen_box: { x: 150, y: 250, width: 120, height: 40 },
      window_screen_box: { x: 120, y: 220, width: 500, height: 400 },
    }),
  ], {
    maxElements: 2,
    windowBounds: capturedWindow,
    requireWindowOwnership: true,
  });
  const captured = result.elements.find((element) => element.name === "Captured window button");
  const sibling = result.elements.find((element) => element.name === "Sibling overlap");
  assert.deepEqual(captured.bounding_box, { x: 40, y: 40, width: 120, height: 40 });
  assert.equal(captured.visible, true);
  assert.equal(sibling.bounding_box, null, "overlapping sibling-window AX geometry was localized into the captured screenshot");
  assert.equal(sibling.visible, false);
  assert.equal(Object.hasOwn(captured, "window_screen_box"), false, "public observation leaked the AX owner-window screen bounds");
  assert.equal(Object.hasOwn(sibling, "window_screen_box"), false, "public observation leaked sibling owner-window screen bounds");
  assert.equal(result.selection.window_ownership_required, true);
}

function missingProcessIdentityCannotMapApplicationContinuation() {
  const before = {
    snapshot_id: "before",
    surface: "application",
    target: { application: "Notes", process_name: "Notes" },
    semantic: { elements: [{ ref: "a0" }] },
  };
  const after = {
    snapshot_id: "after",
    surface: "application",
    target: { application: "Notes", process_name: "Notes" },
    semantic: { elements: [{ ref: "a0" }] },
  };
  const binding = { selector: { identifier: "editor" }, occurrence: 0 };
  const continuation = buildContinuation(
    before,
    after,
    { kind: "ref", ref: "a0", selector: binding.selector, occurrence: 0 },
    { semantic_delta: { added: [], removed: [], changed: [], truncated: false } },
    { application_ref_bindings: new Map([["a0", binding]]) },
    { application_ref_bindings: new Map([["a0", binding]]) },
  );
  assert.equal(continuation.target_identity_continues, false,
    "application continuation treated missing private process identity as same-process authority");
  assert.equal(continuation.mapped_post_target_ref, null,
    "application continuation mapped an old target without private process identity evidence");
  assert.equal(continuation.target_identity_reason, "application_process_identity_unavailable");
}

function coercibleProcessIdentityCannotAuthorizeApplicationContinuity() {
  const before = {
    snapshot_id: "before",
    surface: "application",
    target: { application: "Notes", process_name: "Notes" },
    semantic: { elements: [{ ref: "a0" }] },
  };
  const after = { ...before, snapshot_id: "after" };
  const binding = { selector: { identifier: "editor" }, occurrence: 0 };
  const beforePrivate = {
    application_process_id: "7001",
    application_process_generation: ["gen-7001"],
    application_ref_bindings: new Map([["a0", binding]]),
  };
  const afterPrivate = {
    application_process_id: 7001,
    application_process_generation: "gen-7001",
    application_ref_bindings: new Map([["a0", binding]]),
  };
  const diff = observationDiff(before, after, beforePrivate, afterPrivate);
  assert.equal(diff.process_changed, null, "coercible private process identity was compared as authoritative process state");
  const continuation = buildContinuation(
    before, after,
    { kind: "ref", ref: "a0", selector: binding.selector, occurrence: 0 },
    diff, beforePrivate, afterPrivate,
  );
  assert.equal(continuation.target_identity_continues, false,
    "coercible private process identity authorized application target continuity");
  assert.equal(continuation.target_identity_reason, "application_process_identity_unavailable");
}

function appElement(overrides = {}) {
  return {
    index: 0,
    role: "AXButton",
    subrole: "",
    name: "",
    title: "",
    description: "",
    identifier: "",
    enabled: true,
    focused: false,
    sensitive: false,
    screen_box: null,
    ...overrides,
  };
}
