// Events from the embedded engine to JavaScript, shared by both platforms.
//
// The engines call back on the main thread, but outside any call from
// JavaScript, so every event goes through a thread-safe function: it queues
// onto the event loop and runs the handler with a proper scope.
#pragma once

#include <node_api.h>
#include <string>

struct SvEvent {
  int id;
  std::string type;
  std::string a;
  std::string b;
};

static napi_threadsafe_function g_tsfn = nullptr;

static void sv_call_js(napi_env env, napi_value cb, void*, void* data) {
  SvEvent* e = static_cast<SvEvent*>(data);
  if (env && cb) {
    napi_value obj, v, undef;
    napi_create_object(env, &obj);
    napi_create_int32(env, e->id, &v);
    napi_set_named_property(env, obj, "id", v);
    napi_create_string_utf8(env, e->type.c_str(), e->type.size(), &v);
    napi_set_named_property(env, obj, "type", v);
    napi_create_string_utf8(env, e->a.c_str(), e->a.size(), &v);
    napi_set_named_property(env, obj, "a", v);
    napi_create_string_utf8(env, e->b.c_str(), e->b.size(), &v);
    napi_set_named_property(env, obj, "b", v);
    napi_get_undefined(env, &undef);
    napi_call_function(env, undef, cb, 1, &obj, nullptr);
  }
  delete e;
}

static void sv_emit(int id, const std::string& type, const std::string& a = "", const std::string& b = "") {
  if (!g_tsfn) return;
  napi_call_threadsafe_function(g_tsfn, new SvEvent{id, type, a, b}, napi_tsfn_nonblocking);
}

// setEventHandler(fn): where every view's events go.
static napi_value sv_set_event_handler(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (g_tsfn) {
    napi_release_threadsafe_function(g_tsfn, napi_tsfn_abort);
    g_tsfn = nullptr;
  }
  napi_value name;
  napi_create_string_utf8(env, "streamview", NAPI_AUTO_LENGTH, &name);
  napi_create_threadsafe_function(env, argv[0], nullptr, name, 0, 1, nullptr, nullptr, nullptr,
                                  sv_call_js, &g_tsfn);
  // Never the thing that keeps the process alive.
  napi_unref_threadsafe_function(env, g_tsfn);
  return nullptr;
}

static std::string sv_string(napi_env env, napi_value v) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, nullptr, 0, &len) != napi_ok) return "";
  std::string s(len, '\0');
  napi_get_value_string_utf8(env, v, &s[0], len + 1, &len);
  return s;
}

static std::string sv_prop_string(napi_env env, napi_value obj, const char* key) {
  napi_value v;
  bool has = false;
  napi_has_named_property(env, obj, key, &has);
  if (!has) return "";
  napi_get_named_property(env, obj, key, &v);
  napi_valuetype t;
  napi_typeof(env, v, &t);
  return t == napi_string ? sv_string(env, v) : "";
}

static double sv_prop_number(napi_env env, napi_value obj, const char* key) {
  napi_value v;
  bool has = false;
  napi_has_named_property(env, obj, key, &has);
  if (!has) return 0;
  napi_get_named_property(env, obj, key, &v);
  double d = 0;
  napi_get_value_double(env, v, &d);
  return d;
}

static int32_t sv_int(napi_env env, napi_value v) {
  int32_t i = 0;
  napi_get_value_int32(env, v, &i);
  return i;
}

static bool sv_bool(napi_env env, napi_value v) {
  bool b = false;
  napi_get_value_bool(env, v, &b);
  return b;
}

static void* sv_buffer_pointer(napi_env env, napi_value v) {
  void* data = nullptr;
  size_t len = 0;
  if (napi_get_buffer_info(env, v, &data, &len) != napi_ok || len < sizeof(void*)) return nullptr;
  return *static_cast<void**>(data);
}

// Every platform exports the same seven functions; Windows two more.
static napi_value sv_create(napi_env env, napi_callback_info info);
static napi_value sv_navigate(napi_env env, napi_callback_info info);
static napi_value sv_set_bounds(napi_env env, napi_callback_info info);
static napi_value sv_set_visible(napi_env env, napi_callback_info info);
static napi_value sv_execute_script(napi_env env, napi_callback_info info);
static napi_value sv_destroy(napi_env env, napi_callback_info info);
static napi_value sv_open_dev_tools(napi_env env, napi_callback_info info);
#ifdef _WIN32
// Windows Hello, asked from this process for one of its own windows.
static napi_value sv_verify_presence(napi_env env, napi_callback_info info);
static napi_value sv_cancel_presence(napi_env env, napi_callback_info info);
#endif

static napi_value sv_init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    {"setEventHandler", nullptr, sv_set_event_handler, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"create", nullptr, sv_create, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"navigate", nullptr, sv_navigate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setBounds", nullptr, sv_set_bounds, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setVisible", nullptr, sv_set_visible, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"executeScript", nullptr, sv_execute_script, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"destroy", nullptr, sv_destroy, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"openDevTools", nullptr, sv_open_dev_tools, nullptr, nullptr, nullptr, napi_default, nullptr},
#ifdef _WIN32
    {"verifyPresence", nullptr, sv_verify_presence, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"cancelPresence", nullptr, sv_cancel_presence, nullptr, nullptr, nullptr, napi_default, nullptr},
#endif
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, sv_init)
