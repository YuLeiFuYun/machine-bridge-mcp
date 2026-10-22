import { parse } from "@babel/parser";

/** @param {string} source @param {string} [filename] */
export function parseAst(source, filename = "module.ts") {
  const isDts = /\.d\.[cm]?ts$/u.test(filename);
  return parse(String(source || ""), {
    sourceType: "module",
    sourceFilename: filename,
    plugins: [
      ["typescript", { dts: isDts }],
      "jsx",
      "importAttributes",
      "explicitResourceManagement",
    ],
    createImportExpressions: true,
    attachComment: false,
    errorRecovery: false,
  });
}
