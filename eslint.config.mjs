import tseslint from "typescript-eslint";
export default tseslint.config({
  files: ["src/**/*.ts"],
  languageOptions: { parser: tseslint.parser },
  rules: {
    "no-unreachable": "error",
    "no-constant-binary-expression": "error",
    "no-duplicate-case": "error",
    "no-unsafe-finally": "error",
  },
});
