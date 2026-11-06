export default [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "build/**",
      "dist/**",
      "docs/**",
      "tasks/**",
      "setup/**",
    ],
  },
  {
    rules: {
      "no-unused-vars": "warn",
      "no-console": "off",
    },
  },
];
