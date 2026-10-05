// Scope example 2 - capture of a free variable is refused.
//
// Inside the function body `p` is free (resolves to nothing statically
// visible). Renaming parameter `x` to `p` would capture that free reference,
// so the rename is rejected and the file is left unchanged:
//   node tools/rename-binding/cli.js --old x --new p examples/2-free-capture.js
//   -> rename refused: ... would capture the free variable 'p' ...
function f(x) {
  return x + p
}
