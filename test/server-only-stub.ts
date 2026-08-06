// Stands in for the `server-only` package under Vitest.
//
// `server-only` deliberately throws when imported outside a server component,
// which is exactly the guard we want in the app and exactly the obstacle we do
// not want in a test that calls the query functions directly.
export {};
