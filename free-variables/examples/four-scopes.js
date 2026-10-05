// Four scope kinds in one program:
//   1) function scope (params + body)
//   2) block scope ({ ... }, for head)
//   3) catch scope (catch (e))
//   4) the root/global scope

var top = "root-scope var"        // root binding

function make(a, b = outer) {     // function + parameter scope; `outer` is free
  const local = a + b             // body-local const (block lexical binding)

  {
    let inner = local + helper()  // block scope; `helper` resolves to hoisted fn
    return inner
  }

  function helper() {             // hoisted into function body scope
    try {
      return maybeGlobal + top    // `maybeGlobal` is free; top resolves to root
    } catch (err) {               // catch scope: `err` only visible here
      return err + a + local
    }
  }
}
