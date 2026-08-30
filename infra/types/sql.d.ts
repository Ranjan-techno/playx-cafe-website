// Lets the migration Lambda `import` a .sql file directly and get its contents as a string.
// Backed at bundle time by esbuild's `text` loader — see the `bundling.loader` option on the
// NodejsFunction in infra/lib/constructs/migration.ts.
declare module '*.sql' {
  const content: string;
  export default content;
}
