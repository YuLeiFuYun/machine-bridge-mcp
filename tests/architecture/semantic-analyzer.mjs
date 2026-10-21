// @ts-check
import { parseAst } from "../../scripts/source-syntax.mjs";
export { parseAst } from "../../scripts/source-syntax.mjs";

/**
 * @typedef {{
 *   specifier: string,
 *   kind: "import" | "export-from",
 *   isTypeOnly: boolean,
 *   bindings: Array<{ imported: string, local: string, isType: boolean }>,
 *   defaultBinding: string | null,
 *   namespaceBinding: string | null,
 *   line: number,
 * }} SemanticImport
 */

/**
 * @typedef {{
 *   name: string,
 *   kind: "function" | "class" | "variable" | "type" | "interface" | "enum" | "unknown",
 *   isDefault: boolean,
 *   line: number,
 * }} SemanticExport
 */

/**
 * @typedef {{
 *   callee: string,
 *   memberObject?: string,
 *   memberProperty?: string,
 *   line: number,
 *   argumentCount: number,
 * }} SemanticCall
 */

/**
 * Extract all semantic import and re-export statements from an AST or source.
 * @param {unknown} astOrSource
 * @param {string} [filename]
 * @returns {SemanticImport[]}
 */
export function getSemanticImports(astOrSource, filename = "module.ts") {
  const ast = typeof astOrSource === "string" ? parseAst(astOrSource, filename) : astOrSource;
  /** @type {SemanticImport[]} */
  const imports = [];
  // @ts-ignore
  const body = ast?.program?.body || [];

  for (const node of body) {
    if (node.type === "ImportDeclaration") {
      const specifier = node.source.value;
      const isTypeOnly = node.importKind === "type";
      /** @type {Array<{ imported: string, local: string, isType: boolean }>} */
      const bindings = [];
      let defaultBinding = null;
      let namespaceBinding = null;

      for (const spec of node.specifiers || []) {
        if (spec.type === "ImportDefaultSpecifier") {
          defaultBinding = spec.local.name;
        } else if (spec.type === "ImportNamespaceSpecifier") {
          namespaceBinding = spec.local.name;
        } else if (spec.type === "ImportSpecifier") {
          bindings.push({
            imported: spec.imported.name || spec.imported.value,
            local: spec.local.name,
            isType: isTypeOnly || spec.importKind === "type",
          });
        }
      }

      imports.push({
        specifier,
        kind: "import",
        isTypeOnly,
        bindings,
        defaultBinding,
        namespaceBinding,
        line: node.loc?.start?.line || 1,
      });
    } else if (node.type === "ExportNamedDeclaration" && node.source) {
      const specifier = node.source.value;
      const isTypeOnly = node.exportKind === "type";
      /** @type {Array<{ imported: string, local: string, isType: boolean }>} */
      const bindings = [];

      for (const spec of node.specifiers || []) {
        if (spec.type === "ExportSpecifier") {
          bindings.push({
            imported: spec.local.name || spec.local.value,
            local: spec.exported.name || spec.exported.value,
            isType: isTypeOnly || spec.exportKind === "type",
          });
        }
      }

      imports.push({
        specifier,
        kind: "export-from",
        isTypeOnly,
        bindings,
        defaultBinding: null,
        namespaceBinding: null,
        line: node.loc?.start?.line || 1,
      });
    } else if (node.type === "ExportAllDeclaration" && node.source) {
      imports.push({
        specifier: node.source.value,
        kind: "export-from",
        isTypeOnly: node.exportKind === "type",
        bindings: [],
        defaultBinding: null,
        namespaceBinding: "*",
        line: node.loc?.start?.line || 1,
      });
    }
  }

  return imports;
}

/**
 * Check whether a module semantically imports from targetSpecifier.
 * Unlike source.includes("from './foo'"), this ignores comments and string literals.
 * @param {unknown} astOrSource
 * @param {string | RegExp} target
 * @param {{ requiredSymbols?: string[], forbiddenSymbols?: string[], isTypeOnly?: boolean }} [options]
 * @returns {boolean}
 */
export function hasSemanticImport(astOrSource, target, options = {}) {
  const imports = getSemanticImports(astOrSource);
  const matched = imports.filter((item) => {
    if (typeof target === "string") {
      return item.specifier === target || item.specifier.endsWith(`/${target.replace(/^\.\//, "")}`);
    }
    return target.test(item.specifier);
  });

  if (!matched.length) return false;

  if (options.isTypeOnly !== undefined) {
    if (!matched.some((item) => item.isTypeOnly === options.isTypeOnly)) return false;
  }

  if (Array.isArray(options.requiredSymbols) && options.requiredSymbols.length) {
    const importedNames = new Set(matched.flatMap((item) => [
      item.defaultBinding,
      item.namespaceBinding,
      ...item.bindings.map((b) => b.imported),
    ]).filter(Boolean));
    if (!options.requiredSymbols.every((sym) => importedNames.has(sym))) return false;
  }

  if (Array.isArray(options.forbiddenSymbols) && options.forbiddenSymbols.length) {
    const importedNames = new Set(matched.flatMap((item) => [
      item.defaultBinding,
      item.namespaceBinding,
      ...item.bindings.map((b) => b.imported),
    ]).filter(Boolean));
    if (options.forbiddenSymbols.some((sym) => importedNames.has(sym))) return false;
  }

  return true;
}

/**
 * Extract all semantic exports from an AST or source.
 * @param {unknown} astOrSource
 * @param {string} [filename]
 * @returns {SemanticExport[]}
 */
export function getSemanticExports(astOrSource, filename = "module.ts") {
  const ast = typeof astOrSource === "string" ? parseAst(astOrSource, filename) : astOrSource;
  /** @type {SemanticExport[]} */
  const exports = [];
  // @ts-ignore
  const body = ast?.program?.body || [];

  for (const node of body) {
    if (node.type === "ExportNamedDeclaration") {
      if (node.declaration) {
        const decl = node.declaration;
        if (decl.type === "FunctionDeclaration" && decl.id) {
          exports.push({ name: decl.id.name, kind: "function", isDefault: false, line: decl.loc?.start?.line || 1 });
        } else if (decl.type === "ClassDeclaration" && decl.id) {
          exports.push({ name: decl.id.name, kind: "class", isDefault: false, line: decl.loc?.start?.line || 1 });
        } else if (decl.type === "VariableDeclaration") {
          for (const declarator of decl.declarations) {
            if (declarator.id?.name) {
              const kind = declarator.init?.type === "ArrowFunctionExpression" || declarator.init?.type === "FunctionExpression"
                ? "function"
                : "variable";
              exports.push({ name: declarator.id.name, kind, isDefault: false, line: declarator.loc?.start?.line || 1 });
            }
          }
        } else if (decl.type === "TSInterfaceDeclaration" && decl.id) {
          exports.push({ name: decl.id.name, kind: "interface", isDefault: false, line: decl.loc?.start?.line || 1 });
        } else if (decl.type === "TSTypeAliasDeclaration" && decl.id) {
          exports.push({ name: decl.id.name, kind: "type", isDefault: false, line: decl.loc?.start?.line || 1 });
        } else if (decl.type === "TSEnumDeclaration" && decl.id) {
          exports.push({ name: decl.id.name, kind: "enum", isDefault: false, line: decl.loc?.start?.line || 1 });
        }
      }
      for (const spec of node.specifiers || []) {
        if (spec.type === "ExportSpecifier") {
          exports.push({
            name: spec.exported.name || spec.exported.value,
            kind: "unknown",
            isDefault: (spec.exported.name || spec.exported.value) === "default",
            line: spec.loc?.start?.line || 1,
          });
        }
      }
    } else if (node.type === "ExportDefaultDeclaration") {
      const decl = node.declaration;
      const name = decl.id?.name || (decl.type === "Identifier" ? decl.name : "default");
      const kind = decl.type === "FunctionDeclaration" ? "function" : decl.type === "ClassDeclaration" ? "class" : "variable";
      exports.push({ name, kind, isDefault: true, line: node.loc?.start?.line || 1 });
    }
  }

  return exports;
}

/**
 * Traverse AST and find actual CallExpressions matching callee or object.property.
 * @param {unknown} astOrSource
 * @param {{ callee?: string, memberObject?: string, memberProperty?: string }} query
 * @param {string} [filename]
 * @returns {SemanticCall[]}
 */
export function findSemanticCalls(astOrSource, query, filename = "module.ts") {
  const ast = typeof astOrSource === "string" ? parseAst(astOrSource, filename) : astOrSource;
  /** @type {SemanticCall[]} */
  const calls = [];
  const nodes = [ast];

  while (nodes.length) {
    const node = nodes.pop();
    if (!node || typeof node !== "object") continue;

    if (node.type === "CallExpression") {
      const callee = node.callee;
      let name = "";
      let memberObject = undefined;
      let memberProperty = undefined;

      if (callee.type === "Identifier") {
        name = callee.name;
      } else if (callee.type === "MemberExpression") {
        const objName = callee.object.type === "Identifier" ? callee.object.name : callee.object.type === "ThisExpression" ? "this" : "";
        const propName = callee.property.type === "Identifier" ? callee.property.name : "";
        memberObject = objName;
        memberProperty = propName;
        name = `${objName}.${propName}`;
      }

      let matches = true;
      if (query.callee && name !== query.callee) matches = false;
      if (query.memberObject && memberObject !== query.memberObject) matches = false;
      if (query.memberProperty && memberProperty !== query.memberProperty) matches = false;

      if (matches && (query.callee || query.memberObject || query.memberProperty)) {
        calls.push({
          callee: name,
          memberObject,
          memberProperty,
          line: node.loc?.start?.line || 1,
          argumentCount: Array.isArray(node.arguments) ? node.arguments.length : 0,
        });
      }
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === "object") nodes.push(child);
      } else if (value && typeof value === "object") {
        nodes.push(value);
      }
    }
  }

  return calls;
}

/**
 * Measure semantic code complexity vs pure mechanical raw lines.
 * Distinguishes executable statements and code from comments and docstrings.
 * @param {string} source
 * @param {string} [filename]
 */
export function measureSemanticComplexity(source, filename = "module.ts") {
  const rawLines = source.split(/\r?\n/);
  const totalLines = rawLines.length;

  let codeLines = 0;
  let commentLines = 0;
  let inBlockComment = false;

  for (const raw of rawLines) {
    const line = raw.trim();
    if (!line) continue;

    if (inBlockComment) {
      commentLines += 1;
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }

    if (line.startsWith("/*")) {
      commentLines += 1;
      if (!line.includes("*/")) inBlockComment = true;
      continue;
    }

    if (line.startsWith("//") || line.startsWith("*")) {
      commentLines += 1;
      continue;
    }

    codeLines += 1;
  }

  let statementCount = 0;
  let nodeCount = 0;
  try {
    const ast = parseAst(source, filename);
    const nodes = [ast];
    while (nodes.length) {
      const node = nodes.pop();
      if (!node || typeof node !== "object") continue;
      nodeCount += 1;
      if (node.type && (node.type.endsWith("Statement") || node.type.endsWith("Declaration"))) statementCount += 1;
      for (const val of Object.values(node)) {
        if (Array.isArray(val)) {
          for (const item of val) if (item && typeof item === "object") nodes.push(item);
        } else if (val && typeof val === "object") nodes.push(val);
      }
    }
  } catch {
    statementCount = codeLines;
  }

  return {
    totalLines,
    codeLines,
    commentLines,
    statementCount,
    nodeCount,
  };
}

/**
 * Assert that an AST or code respects semantic boundary rules.
 * @param {string} source
 * @param {{
 *   maxCodeLines?: number,
 *   maxStatements?: number,
 *   requiredImports?: string[],
 *   forbiddenImports?: string[],
 *   forbiddenCalls?: Array<{ memberObject?: string, memberProperty?: string, callee?: string }>,
 *   filename?: string,
 * }} rules
 * @param {string} [label]
 */
export function assertSemanticBoundary(source, rules, label = "module") {
  const filename = rules.filename || "module.ts";

  if (rules.maxCodeLines !== undefined || rules.maxStatements !== undefined) {
    const complexity = measureSemanticComplexity(source, filename);
    if (rules.maxCodeLines !== undefined && complexity.codeLines > rules.maxCodeLines) {
      throw new Error(`${label} exceeds semantic code lines boundary (${complexity.codeLines} > ${rules.maxCodeLines} lines; ${complexity.commentLines} comment lines excluded)`);
    }
    if (rules.maxStatements !== undefined && complexity.statementCount > rules.maxStatements) {
      throw new Error(`${label} exceeds statement complexity boundary (${complexity.statementCount} > ${rules.maxStatements} statements)`);
    }
  }

  if (rules.requiredImports) {
    for (const req of rules.requiredImports) {
      if (!hasSemanticImport(source, req)) {
        throw new Error(`${label} missing required semantic import: ${req}`);
      }
    }
  }

  if (rules.forbiddenImports) {
    for (const forb of rules.forbiddenImports) {
      if (hasSemanticImport(source, forb)) {
        throw new Error(`${label} contains forbidden semantic import: ${forb}`);
      }
    }
  }

  if (rules.forbiddenCalls) {
    for (const callQuery of rules.forbiddenCalls) {
      const matches = findSemanticCalls(source, callQuery, filename);
      if (matches.length > 0) {
        const queryStr = callQuery.callee || `${callQuery.memberObject}.${callQuery.memberProperty}`;
        throw new Error(`${label} calls forbidden operation: ${queryStr} at line ${matches[0].line}`);
      }
    }
  }
}
