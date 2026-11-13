/*
 * Native shim for the Lean-in-core spike (PLAN §A3, M1). It initializes the Lean runtime
 * once, initializes each calling thread, and exchanges C strings with the model's
 * `pcs_answer : String -> String` (model/ReviewProcess/Ffi.lean).
 */
#include <lean/lean.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>

extern void lean_initialize_runtime_module(void);
extern void lean_initialize_thread(void);
extern lean_object *initialize_ReviewProcess_ReviewProcess(uint8_t builtin, lean_object *w);
extern lean_object *pcs_answer(lean_object *query);

static pthread_once_t once = PTHREAD_ONCE_INIT;
static int init_status = -1;
static __thread int thread_ready = 0;

static void init_runtime(void) {
    lean_initialize_runtime_module();
    lean_object *r = initialize_ReviewProcess_ReviewProcess(1, lean_io_mk_world());
    if (lean_io_result_is_ok(r)) {
        init_status = 0;
    } else {
        lean_io_result_show_error(r);
        init_status = 1;
    }
    lean_dec_ref(r);
    lean_io_mark_end_initialization();
    thread_ready = 1;
}

/* 0 on success. Safe to call from any thread, any number of times. */
int pcs_init(void) {
    pthread_once(&once, init_runtime);
    if (init_status == 0 && !thread_ready) {
        lean_initialize_thread();
        thread_ready = 1;
    }
    return init_status;
}

/* The model's answer to one JSON query; free it with pcs_free. */
char *pcs_query(const char *query) {
    if (pcs_init() != 0) return strdup("{\"error\":\"lean runtime failed to initialize\"}");
    lean_object *r = pcs_answer(lean_mk_string(query));
    char *out = strdup(lean_string_cstr(r));
    lean_dec_ref(r);
    return out;
}

void pcs_free(char *p) { free(p); }
