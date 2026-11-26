// Datum's own binding as a binding module (the contract's `createBinding(lit, datum)`), so the tester
// runs Datum's binding through the same path it runs a design-system binding. The host hands every
// binding the Datum binding to stand behind it; Datum's binding is that binding itself. Plain ESM with
// no imports: the tester serves it as written.
export const createBinding = (_lit, datum) => datum;
