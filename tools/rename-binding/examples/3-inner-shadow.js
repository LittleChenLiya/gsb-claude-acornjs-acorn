// Scope example 3 - inner same-named binding (shadowing) is refused.
//
// A nested scope already declares the desired new name `p`: after the rename
// the inner `p` would shadow the renamed parameter for the uses below it.
// The tool refuses and leaves the source untouched:
//   node tools/rename-binding/cli.js --old x --new p examples/3-inner-shadow.js
//   -> rename refused: ... shadowed by an inner binding ...
function f(x) {
  function g(p) {
    return p
  }
  return g(x) + x
}
