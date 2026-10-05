// Example input for bin/insert-use-strict.mjs: three plain functions.
// The comment below only *mentions* "use strict" - it is not a directive.
// "use strict"
function alpha(a) {
  return a + 1
}

function beta(b) {
  function gamma(c) { // nested plain function: reported as affected sub-scope
    return c * 2
  }
  return gamma(b) + alpha(b)
}

function delta(d) {
  return d - 1
}
