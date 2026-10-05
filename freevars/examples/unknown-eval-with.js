// 未知项：with 与动态 eval 会破坏静态解析的完整性，单独列出。
function g(obj) {
  with (obj) {
    // x 可能解析为 obj.x -> 标记未知，不假装完整
    return x
  }
}
function h() {
  eval("var z = 1")
  // z 可能由 eval 引入 -> 未知
  return z
}
g({x: 1})
h()
