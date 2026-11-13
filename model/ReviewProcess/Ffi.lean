import ReviewProcess.Query
/-
  The Lean-in-core spike (PLAN §A3, M1): the model's answers exported as one C symbol, so
  `core` can call the proved decision functions in-process instead of a re-implementation.
  The native shim (model/ffi/pcs_ffi.c) initializes the Lean runtime and wraps strings.
-/
namespace ReviewProcess

@[export pcs_answer]
def pcsAnswer (query : String) : String := answerText query

end ReviewProcess
