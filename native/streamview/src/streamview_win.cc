// Streaming view, Windows: Microsoft's WebView2 (Edge's engine) inside a
// Debrowser window, for the sites whose DRM needs PlayReady - which Windows
// provides through WebView2 and Chromium's Widevine does not.
//
// A child window of the Electron window, sized over the page area by
// JavaScript. WebView2 answers on the thread that created it, which is the
// main thread here, and events go back through the thread-safe function in
// events.h.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wrl.h>

#include <cstdio>
#include <map>
#include <string>

#include <UserConsentVerifierInterop.h>
#include <roapi.h>
#include <windows.security.credentials.ui.h>
#include <wrl/wrappers/corewrappers.h>

#include "WebView2.h"
#include "WebView2EnvironmentOptions.h"
#include "events.h"

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Make;
using Microsoft::WRL::Wrappers::HStringReference;
namespace CredUI = ABI::Windows::Security::Credentials::UI;
namespace WF = ABI::Windows::Foundation;

namespace {

struct View {
  int id = 0;
  HWND parent = nullptr;
  RECT bounds{};
  bool visible = true;
  bool closed = false;
  std::wstring pendingUrl;
  ComPtr<ICoreWebView2Controller> controller;
  ComPtr<ICoreWebView2> webview;
};

std::map<int, View*> g_views;
int g_next_id = 1;

std::wstring Wide(const std::string& s) {
  if (s.empty()) return std::wstring();
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), &w[0], n);
  return w;
}

std::string Narrow(const wchar_t* w) {
  if (!w || !*w) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n - 1 : 0, '\0');
  if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
  return s;
}

std::string Hex(HRESULT hr) {
  char buf[16];
  std::snprintf(buf, sizeof(buf), "0x%08lX", static_cast<unsigned long>(hr));
  return buf;
}

View* Find(int id) {
  auto it = g_views.find(id);
  return it == g_views.end() || it->second->closed ? nullptr : it->second;
}

void Attach(View* v) {
  const int id = v->id;
  v->controller->put_Bounds(v->bounds);
  v->controller->put_IsVisible(v->visible ? TRUE : FALSE);
  v->controller->get_CoreWebView2(&v->webview);

  EventRegistrationToken token;
  v->webview->add_NavigationCompleted(
      Callback<ICoreWebView2NavigationCompletedEventHandler>(
          [id](ICoreWebView2* sender, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
            BOOL ok = FALSE;
            args->get_IsSuccess(&ok);
            wchar_t* uri = nullptr;
            sender->get_Source(&uri);
            sv_emit(id, "navigated", Narrow(uri), ok ? "ok" : "failed");
            CoTaskMemFree(uri);
            return S_OK;
          })
          .Get(),
      &token);
  v->webview->add_DocumentTitleChanged(
      Callback<ICoreWebView2DocumentTitleChangedEventHandler>(
          [id](ICoreWebView2* sender, IUnknown*) -> HRESULT {
            wchar_t* title = nullptr;
            sender->get_DocumentTitle(&title);
            sv_emit(id, "title", Narrow(title));
            CoTaskMemFree(title);
            return S_OK;
          })
          .Get(),
      &token);

  if (!v->pendingUrl.empty()) v->webview->Navigate(v->pendingUrl.c_str());

  wchar_t* ua = nullptr;
  ComPtr<ICoreWebView2Settings> settings;
  std::string agent;
  if (SUCCEEDED(v->webview->get_Settings(&settings))) {
    ComPtr<ICoreWebView2Settings2> settings2;
    if (SUCCEEDED(settings.As(&settings2)) && SUCCEEDED(settings2->get_UserAgent(&ua))) {
      agent = Narrow(ua);
      CoTaskMemFree(ua);
    }
  }
  sv_emit(id, "ready", agent);
}

}  // namespace

// create(windowHandle: Buffer, { userDataDir, url, x, y, width, height, args }) -> id
static napi_value sv_create(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  HWND parent = static_cast<HWND>(sv_buffer_pointer(env, argv[0]));
  if (!parent || !IsWindow(parent)) {
    napi_throw_error(env, nullptr, "streamview: not a window handle");
    return nullptr;
  }

  View* v = new View();
  v->id = g_next_id++;
  v->parent = parent;
  const LONG x = static_cast<LONG>(sv_prop_number(env, argv[1], "x"));
  const LONG y = static_cast<LONG>(sv_prop_number(env, argv[1], "y"));
  v->bounds = {x, y, x + static_cast<LONG>(sv_prop_number(env, argv[1], "width")),
               y + static_cast<LONG>(sv_prop_number(env, argv[1], "height"))};
  v->pendingUrl = Wide(sv_prop_string(env, argv[1], "url"));
  g_views[v->id] = v;

  const std::wstring dataDir = Wide(sv_prop_string(env, argv[1], "userDataDir"));
  const std::wstring extra = Wide(sv_prop_string(env, argv[1], "args"));
  auto options = Make<CoreWebView2EnvironmentOptions>();
  if (!extra.empty()) options->put_AdditionalBrowserArguments(extra.c_str());

  const int id = v->id;
  HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(
      nullptr, dataDir.empty() ? nullptr : dataDir.c_str(), options.Get(),
      Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
          [id](HRESULT result, ICoreWebView2Environment* environment) -> HRESULT {
            View* view = Find(id);
            if (!view) return S_OK;
            if (FAILED(result) || !environment) {
              sv_emit(id, "error", "environment", Hex(result));
              return S_OK;
            }
            wchar_t* version = nullptr;
            environment->get_BrowserVersionString(&version);
            sv_emit(id, "runtime", Narrow(version));
            CoTaskMemFree(version);
            return environment->CreateCoreWebView2Controller(
                view->parent,
                Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                    [id](HRESULT result, ICoreWebView2Controller* controller) -> HRESULT {
                      View* view = Find(id);
                      if (!view) {
                        if (controller) controller->Close();
                        return S_OK;
                      }
                      if (FAILED(result) || !controller) {
                        sv_emit(id, "error", "controller", Hex(result));
                        return S_OK;
                      }
                      view->controller = controller;
                      Attach(view);
                      return S_OK;
                    })
                    .Get());
          })
          .Get());
  if (FAILED(hr)) sv_emit(id, "error", "start", Hex(hr));

  napi_value out;
  napi_create_int32(env, id, &out);
  return out;
}

// navigate(id, url)
static napi_value sv_navigate(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  View* v = Find(sv_int(env, argv[0]));
  if (!v) return nullptr;
  const std::wstring url = Wide(sv_string(env, argv[1]));
  if (v->webview) v->webview->Navigate(url.c_str());
  else v->pendingUrl = url;
  return nullptr;
}

// setBounds(id, x, y, width, height) - in the window's client pixels.
static napi_value sv_set_bounds(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  View* v = Find(sv_int(env, argv[0]));
  if (!v) return nullptr;
  const LONG x = sv_int(env, argv[1]), y = sv_int(env, argv[2]);
  v->bounds = {x, y, x + sv_int(env, argv[3]), y + sv_int(env, argv[4])};
  if (v->controller) v->controller->put_Bounds(v->bounds);
  return nullptr;
}

// setVisible(id, visible)
static napi_value sv_set_visible(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  View* v = Find(sv_int(env, argv[0]));
  if (!v) return nullptr;
  v->visible = sv_bool(env, argv[1]);
  if (v->controller) v->controller->put_IsVisible(v->visible ? TRUE : FALSE);
  return nullptr;
}

// executeScript(id, token, script) - the result arrives as a "script" event
// carrying the token and the value as JSON. A promise is not awaited.
static napi_value sv_execute_script(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const int id = sv_int(env, argv[0]);
  View* v = Find(id);
  const std::string token = sv_string(env, argv[1]);
  if (!v || !v->webview) {
    sv_emit(id, "script", token, "null");
    return nullptr;
  }
  const std::wstring script = Wide(sv_string(env, argv[2]));
  v->webview->ExecuteScript(
      script.c_str(),
      Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
          [id, token](HRESULT hr, LPCWSTR json) -> HRESULT {
            sv_emit(id, "script", token, SUCCEEDED(hr) && json ? Narrow(json) : "null");
            return S_OK;
          })
          .Get());
  return nullptr;
}

// openDevTools(id) - the engine's own inspector, in a window of its own. For
// --streamview-test: a player that fails says why in its console.
static napi_value sv_open_dev_tools(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  View* v = Find(sv_int(env, argv[0]));
  if (v && v->webview) v->webview->OpenDevToolsWindow();
  return nullptr;
}

// destroy(id)
static napi_value sv_destroy(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const int id = sv_int(env, argv[0]);
  auto it = g_views.find(id);
  if (it == g_views.end()) return nullptr;
  View* v = it->second;
  v->closed = true;
  if (v->controller) v->controller->Close();
  v->webview.Reset();
  v->controller.Reset();
  g_views.erase(it);
  delete v;
  return nullptr;
}

// verifyPresence(windowHandle: Buffer, message, token) - Windows Hello for
// the given window. The answer arrives as a "presence" event (id 0) carrying
// the token and the UserConsentVerificationResult as a number, or "error".
//
// Asked from here rather than from a helper process: the prompt is modal to
// the window, and only the process that owns the window - the one the user
// is looking at - is allowed to bring a prompt to the front.
static napi_value sv_verify_presence(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  HWND hwnd = static_cast<HWND>(sv_buffer_pointer(env, argv[0]));
  const std::wstring message = Wide(sv_string(env, argv[1]));
  const std::string token = sv_string(env, argv[2]);
  auto fail = [&](const char* where, HRESULT hr) {
    sv_emit(0, "presence", token, std::string("error ") + where + " " + Hex(hr));
    return nullptr;
  };
  if (!hwnd || !IsWindow(hwnd)) return fail("window", E_INVALIDARG);

  ComPtr<IUserConsentVerifierInterop> interop;
  HRESULT hr = RoGetActivationFactory(
      HStringReference(RuntimeClass_Windows_Security_Credentials_UI_UserConsentVerifier).Get(),
      IID_PPV_ARGS(&interop));
  if (FAILED(hr)) return fail("factory", hr);

  ComPtr<WF::IAsyncOperation<CredUI::UserConsentVerificationResult>> op;
  hr = interop->RequestVerificationForWindowAsync(
      hwnd, HStringReference(message.c_str(), static_cast<unsigned int>(message.size())).Get(),
      IID_PPV_ARGS(&op));
  if (FAILED(hr)) return fail("request", hr);

  hr = op->put_Completed(
      Callback<WF::IAsyncOperationCompletedHandler<CredUI::UserConsentVerificationResult>>(
          [token](WF::IAsyncOperation<CredUI::UserConsentVerificationResult>* done,
                  WF::AsyncStatus status) -> HRESULT {
            CredUI::UserConsentVerificationResult result;
            if (status != WF::AsyncStatus::Completed || FAILED(done->GetResults(&result))) {
              sv_emit(0, "presence", token, "error status " + std::to_string(static_cast<int>(status)));
            } else {
              sv_emit(0, "presence", token, std::to_string(static_cast<int>(result)));
            }
            return S_OK;
          })
          .Get());
  if (FAILED(hr)) return fail("completed", hr);
  return nullptr;
}
