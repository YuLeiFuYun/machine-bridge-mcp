export function createManagedJobResourceContext(materialize) {
  let attempted = false;
  let value = { paths: {}, bytes: {}, redactions: {}, temporaryPaths: {} };
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
