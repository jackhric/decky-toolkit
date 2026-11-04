// minimal bundle for plugin_frontend_check tests
const getStatus = callable("get_status");
await call("set_volume", 3);
const missing = callable("missing_method");
const unrelated = other("not_a_call");
await call("ghost");
