# Local seeding

`npm run demo` seeds Alice and Bob with synthetic data and dummy secrets.
`npm run demo:reset` recreates only the running demo session and its demo-owned
stores. No production or operator resource is reset. Browser tests retain their
own separate authenticated fixture controls and accounts. See
[presenter instructions](../../poc/demo.md).
