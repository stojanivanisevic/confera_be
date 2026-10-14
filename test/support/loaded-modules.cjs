// Preloaded into a start of the application by a test (`node --require ...`): when the
// process ends, it says on stdout which parts of the application it had loaded.
//
//   LOADED configuration=true application=false
//
// "application" is src/bootstrap, which brings the framework, the database client and
// every module with it. A start that the configuration refuses must end without it.
process.on('exit', () => {
  const loaded = Object.keys(require.cache).map((file) => file.replaceAll('\\', '/'));
  const has = (name) => loaded.some((file) => file.endsWith(name));
  process.stdout.write(
    `LOADED configuration=${String(has('/config/env.js'))} application=${String(has('/bootstrap.js'))}\n`,
  );
});
