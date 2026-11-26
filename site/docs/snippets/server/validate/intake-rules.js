({
  validators: [
    (context) => {
      const errors = [];
      // A full name has a first and a last name in it.
      const name = context.values.fullName;
      context.log.debug("full name", { fullName: name });
      if (typeof name === "string" && name.trim() !== "" && !name.trim().includes(" ")) {
        errors.push({ code: "custom.fullNameIncomplete", componentId: "fullName", path: "fullName", stage: "intake-rules", source: "custom" });
      }
      // Phone contact is offered in some countries only: a rule over two fields, against the
      // list the page injected (the sandbox cannot fetch one; see wasmExternalData).
      const offered = (context.externalData || {}).phoneCountries || [];
      const country = context.values.country;
      context.log.debug("phone contact", { method: context.values.contactMethod, country, offered });
      if (context.values.contactMethod === "phone" && country && !offered.includes(country)) {
        errors.push({ code: "custom.phoneNotOffered", componentId: "contactMethod", path: "contactMethod", stage: "intake-rules", source: "custom" });
      }
      // What a rule says travels back with the outcome (the sandbox has no console): see wasm-log-level.
      context.log.info("intake rules: " + errors.length + " error(s)");
      return { errors };
    }
  ]
})
