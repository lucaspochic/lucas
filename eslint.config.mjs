import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: [".next/**", ".tools/**", ".data/**", "node_modules/**", "drizzle/**", "next-env.d.ts"],
  },
];

export default config;
