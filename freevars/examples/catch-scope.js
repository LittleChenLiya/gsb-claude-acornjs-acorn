// catch 作用域：catch 参数只在 catch 体内绑定，catch 体外不可见。
function f() {
  try {
    throw new Error("boom")
  } catch (e) {
    const handled = e.message
    return handled
  }
}
f()
