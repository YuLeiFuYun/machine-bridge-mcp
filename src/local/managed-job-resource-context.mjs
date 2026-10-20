// @ts-check
/** @param {() => any} materialize */
export function createManagedJobResourceContext(materialize) {
  let attempted = false;
  /** @type {any} */
  let value = { paths: {}, bytes: {}, redactions: {}, temporaryPaths: {} };
  /** @type {any} */
  let error = null;
  return {
    get attempted() { return attempted; },
    get value() { return value; },
    ensure() {
      if (error) throw error;
      if (attempted) return value;
      attempted = true;
      try { value = materialize(); }
      catch (cause) { error = cause; throw cause; }
      return value;
    },
  };
}
