/*
 * setup-ui: the installer's and uninstaller's window, drawn in the browser's
 * own design instead of NSIS's.
 *
 *     setup-ui.exe install <pid>
 *     setup-ui.exe uninstall <pid>
 *
 * NSIS draws its one-click progress window ("SpiderBanner") with the system's
 * dialog controls, which nothing can restyle. packaging/installer.nsh starts
 * this instead, from .onInit, and only then makes the installer silent - so if
 * this cannot start (no file, or the system refuses an unsigned program), the
 * installer keeps its own window and nothing is lost.
 *
 * What it does:
 *   - shows a small borderless window: the mark, a title, a line, and an
 *     indeterminate progress bar, in the Ledger palette, light or dark as the
 *     system is;
 *   - closes itself when process <pid> - the installer - exits, or when it
 *     sends SETUP_UI_DONE;
 *   - answers SETUP_UI_ASK, sent while Debrowser is running: the window turns
 *     into the question "Debrowser is open", with Cancel and Close and install,
 *     and the SendMessage returns 1 to go on or 0 to stop. Only the installer
 *     asks; it waits on the answer.
 *
 * Windows only, C with no runtime beyond the system's: user32, gdi32, shell32,
 * and GDI+ for antialiased shapes (its flat API, declared here, because the
 * SDK's header is C++). Built by tools/build-helper.js.
 */

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <stdlib.h>
#include <wchar.h>

#define SETUP_UI_CLASS L"DebrowserSetup"
#define SETUP_UI_ASK (WM_APP + 1)
#define SETUP_UI_DONE (WM_APP + 2)
#define TIMER_FRAME 1

/* ---- GDI+ flat API, the few calls used ---------------------------------- */

typedef struct {
  UINT32 GdiplusVersion;
  void *DebugEventCallback;
  BOOL SuppressBackgroundThread;
  BOOL SuppressExternalCodecs;
} GdiplusStartupInput;

int WINAPI GdiplusStartup(ULONG_PTR *token, const GdiplusStartupInput *input, void *output);
void WINAPI GdiplusShutdown(ULONG_PTR token);
int WINAPI GdipCreateFromHDC(HDC hdc, void **graphics);
int WINAPI GdipDeleteGraphics(void *graphics);
int WINAPI GdipSetSmoothingMode(void *graphics, int mode);
int WINAPI GdipSetPixelOffsetMode(void *graphics, int mode);
int WINAPI GdipCreateSolidFill(DWORD argb, void **brush);
int WINAPI GdipDeleteBrush(void *brush);
int WINAPI GdipCreatePen1(DWORD argb, float width, int unit, void **pen);
int WINAPI GdipDeletePen(void *pen);
int WINAPI GdipCreatePath(int fillMode, void **path);
int WINAPI GdipDeletePath(void *path);
int WINAPI GdipAddPathArc(void *path, float x, float y, float w, float h, float start, float sweep);
int WINAPI GdipClosePathFigure(void *path);
int WINAPI GdipFillPath(void *graphics, void *brush, void *path);
int WINAPI GdipDrawPath(void *graphics, void *pen, void *path);
int WINAPI GdipFillEllipse(void *graphics, void *brush, float x, float y, float w, float h);

#define SMOOTHING_ANTIALIAS 4
#define PIXEL_OFFSET_HALF 4
#define UNIT_PIXEL 2

/* ---- The palette: Ledger's (src/renderer/theme.css) --------------------- */

typedef struct {
  COLORREF bg, border, text, dim, track, accent, accentHover, ghostHover;
} Palette;

static const Palette DARK = {
  RGB(0x1a, 0x1c, 0x1b), RGB(0x2e, 0x32, 0x2f), RGB(0xe6, 0xe8, 0xe4), RGB(0x8e, 0x94, 0x8f),
  RGB(0x21, 0x24, 0x22), RGB(0x2f, 0x85, 0x7b), RGB(0x4e, 0x96, 0x8d), RGB(0x24, 0x27, 0x25)
};
static const Palette LIGHT = {
  RGB(0xf7, 0xf8, 0xf5), RGB(0xcd, 0xd3, 0xcb), RGB(0x1c, 0x23, 0x20), RGB(0x5f, 0x6a, 0x64),
  RGB(0xe1, 0xe5, 0xdf), RGB(0x2f, 0x85, 0x7b), RGB(0x27, 0x70, 0x67), RGB(0xec, 0xee, 0xea)
};

/* ---- State --------------------------------------------------------------- */

typedef enum { MODE_INSTALL, MODE_UNINSTALL } Mode;

static struct {
  HWND hwnd;
  Mode mode;
  const Palette *pal;
  UINT dpi;
  BOOL dwmEdge;          /* the system draws the rounded edge and its border */
  BOOL motion;           /* the system's "Show animations" */
  ULONGLONG start;
  HFONT fontTitle, fontBody, fontMark, fontButton;
  /* The question. */
  BOOL asking;
  int answer;            /* -1 while undecided, 0 cancel, 1 go on */
  int hover, pressed, focus; /* button index: 0 Cancel, 1 Close and install, -1 none */
  RECT buttons[2];
} ui;

static float S(float dip) { return dip * (float)ui.dpi / 96.0f; }
static int SI(float dip) { return (int)(S(dip) + 0.5f); }
static DWORD ARGB(COLORREF c, BYTE a) {
  return ((DWORD)a << 24) | ((DWORD)GetRValue(c) << 16) | ((DWORD)GetGValue(c) << 8) | GetBValue(c);
}

/* ---- System facts, each asked of the OS the cheap way ------------------- */

static BOOL lightTheme(void) {
  DWORD value = 0, size = sizeof value;
  if (RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                   L"AppsUseLightTheme", RRF_RT_REG_DWORD, NULL, &value, &size) != ERROR_SUCCESS) return FALSE;
  return value != 0;
}

static void becomeDpiAware(void) {
  typedef BOOL (WINAPI *SetCtx)(HANDLE);
  HMODULE user = GetModuleHandleW(L"user32.dll");
  SetCtx set = user ? (SetCtx)(void *)GetProcAddress(user, "SetProcessDpiAwarenessContext") : NULL;
  /* DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 is (HANDLE)-4. */
  if (!set || !set((HANDLE)(LONG_PTR)-4)) SetProcessDPIAware();
}

static UINT dpiOf(HWND hwnd) {
  typedef UINT (WINAPI *GetDpi)(HWND);
  HMODULE user = GetModuleHandleW(L"user32.dll");
  GetDpi get = user ? (GetDpi)(void *)GetProcAddress(user, "GetDpiForWindow") : NULL;
  if (get && hwnd) return get(hwnd);
  HDC screen = GetDC(NULL);
  UINT dpi = (UINT)GetDeviceCaps(screen, LOGPIXELSX);
  ReleaseDC(NULL, screen);
  return dpi ? dpi : 96;
}

/* Windows 11's rounded corners and its one-pixel border, in our colour. */
static BOOL roundCorners(HWND hwnd, COLORREF border) {
  typedef HRESULT (WINAPI *SetAttr)(HWND, DWORD, LPCVOID, DWORD);
  HMODULE dwm = LoadLibraryW(L"dwmapi.dll");
  SetAttr set = dwm ? (SetAttr)(void *)GetProcAddress(dwm, "DwmSetWindowAttribute") : NULL;
  if (!set) return FALSE;
  int round = 2;                                   /* DWMWCP_ROUND */
  if (FAILED(set(hwnd, 33, &round, sizeof round))) return FALSE;  /* DWMWA_WINDOW_CORNER_PREFERENCE */
  set(hwnd, 34, &border, sizeof border);           /* DWMWA_BORDER_COLOR */
  return TRUE;
}

static HFONT makeFont(float px, int weight) {
  /* Windows 11's face first, the one every Windows since Vista has second. */
  static const wchar_t *faces[] = { L"Segoe UI Variable Text", L"Segoe UI" };
  HDC dc = GetDC(NULL);
  HFONT chosen = NULL;
  for (size_t i = 0; i < sizeof faces / sizeof *faces && !chosen; i++) {
    HFONT font = CreateFontW(-SI(px), 0, 0, 0, weight, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                             OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                             DEFAULT_PITCH | FF_SWISS, faces[i]);
    wchar_t got[LF_FACESIZE] = { 0 };
    HGDIOBJ old = SelectObject(dc, font);
    GetTextFaceW(dc, LF_FACESIZE, got);
    SelectObject(dc, old);
    /* A face that is not installed is silently swapped for another; asked back, it says which. */
    if (_wcsicmp(got, faces[i]) == 0 || i + 1 == sizeof faces / sizeof *faces) chosen = font;
    else DeleteObject(font);
  }
  ReleaseDC(NULL, dc);
  return chosen;
}

static void makeFonts(void) {
  HFONT *all[] = { &ui.fontTitle, &ui.fontBody, &ui.fontMark, &ui.fontButton };
  for (size_t i = 0; i < sizeof all / sizeof *all; i++) if (*all[i]) DeleteObject(*all[i]);
  ui.fontTitle = makeFont(19, FW_SEMIBOLD);
  ui.fontBody = makeFont(14, FW_NORMAL);
  ui.fontMark = makeFont(14, FW_BOLD);
  ui.fontButton = makeFont(14, FW_NORMAL);
}

/* ---- Drawing ------------------------------------------------------------- */

#define WIDTH 400
#define HEIGHT 220
#define PAD 28

static void *roundedRect(float x, float y, float w, float h, float r) {
  void *path = NULL;
  if (r * 2 > w) r = w / 2;
  if (r * 2 > h) r = h / 2;
  float d = r * 2;
  GdipCreatePath(0, &path);
  GdipAddPathArc(path, x, y, d, d, 180, 90);
  GdipAddPathArc(path, x + w - d, y, d, d, 270, 90);
  GdipAddPathArc(path, x + w - d, y + h - d, d, d, 0, 90);
  GdipAddPathArc(path, x, y + h - d, d, d, 90, 90);
  GdipClosePathFigure(path);
  return path;
}

static void fillRounded(void *g, float x, float y, float w, float h, float r, DWORD argb) {
  if (w <= 0 || h <= 0) return;
  void *brush = NULL, *path = roundedRect(x, y, w, h, r);
  GdipCreateSolidFill(argb, &brush);
  GdipFillPath(g, brush, path);
  GdipDeleteBrush(brush);
  GdipDeletePath(path);
}

static void strokeRounded(void *g, float x, float y, float w, float h, float r, float width, DWORD argb) {
  void *pen = NULL, *path = roundedRect(x, y, w, h, r);
  GdipCreatePen1(argb, width, UNIT_PIXEL, &pen);
  GdipDrawPath(g, pen, path);
  GdipDeletePen(pen);
  GdipDeletePath(path);
}

/* The mark, as on the new tab page: a frame - one tab - and the dot, the one awake. */
static void drawMark(void *g, float x, float y, float size) {
  float k = size / 64.0f;
  strokeRounded(g, x + 10 * k, y + 10 * k, 44 * k, 44 * k, 13 * k, 5.5f * k, ARGB(ui.pal->text, 255));
  void *brush = NULL;
  GdipCreateSolidFill(ARGB(ui.pal->accent, 255), &brush);
  GdipFillEllipse(g, brush, x + 19 * k, y + 19 * k, 14 * k, 14 * k);
  GdipDeleteBrush(brush);
}

static float easeInOut(float t) {
  return t < 0.5f ? 4 * t * t * t : 1 - (-2 * t + 2) * (-2 * t + 2) * (-2 * t + 2) / 2;
}

static const wchar_t *titleText(void) {
  if (ui.asking) return L"Debrowser is open";
  return ui.mode == MODE_INSTALL ? L"Installing Debrowser" : L"Removing Debrowser";
}

static const wchar_t *bodyText(void) {
  if (ui.asking) return L"It will close to finish installing, and offer your tabs back when it opens again.";
  return ui.mode == MODE_INSTALL ? L"This takes a few seconds. Debrowser opens when it is done."
                                 : L"This takes a few seconds.";
}

static const wchar_t *BUTTON_TEXT[2] = { L"Cancel", L"Close and install" };

static void layoutButtons(HDC dc) {
  HGDIOBJ old = SelectObject(dc, ui.fontButton);
  int right = SI(WIDTH - PAD), bottom = SI(HEIGHT - PAD), h = SI(32);
  for (int i = 1; i >= 0; i--) {
    SIZE text;
    GetTextExtentPoint32W(dc, BUTTON_TEXT[i], (int)wcslen(BUTTON_TEXT[i]), &text);
    int w = text.cx + SI(32);
    SetRect(&ui.buttons[i], right - w, bottom - h, right, bottom);
    right -= w + SI(8);
  }
  SelectObject(dc, old);
}

static void paint(HDC target) {
  RECT rc;
  GetClientRect(ui.hwnd, &rc);
  int w = rc.right, h = rc.bottom;
  HDC dc = CreateCompatibleDC(target);
  HBITMAP bmp = CreateCompatibleBitmap(target, w, h);
  HGDIOBJ oldBmp = SelectObject(dc, bmp);

  HBRUSH bg = CreateSolidBrush(ui.pal->bg);
  FillRect(dc, &rc, bg);
  DeleteObject(bg);

  void *g = NULL;
  GdipCreateFromHDC(dc, &g);
  GdipSetSmoothingMode(g, SMOOTHING_ANTIALIAS);
  GdipSetPixelOffsetMode(g, PIXEL_OFFSET_HALF);

  if (!ui.dwmEdge) strokeRounded(g, 0.5f, 0.5f, (float)w - 1, (float)h - 1, 0, 1, ARGB(ui.pal->border, 255));
  drawMark(g, S(PAD), S(PAD), S(28));

  if (ui.asking) {
    layoutButtons(dc);
    for (int i = 0; i < 2; i++) {
      RECT b = ui.buttons[i];
      float bx = (float)b.left, by = (float)b.top, bw = (float)(b.right - b.left), bh = (float)(b.bottom - b.top);
      BOOL lit = ui.hover == i || ui.pressed == i;
      if (i == 1) fillRounded(g, bx, by, bw, bh, S(6), ARGB(lit ? ui.pal->accentHover : ui.pal->accent, 255));
      else {
        if (lit) fillRounded(g, bx, by, bw, bh, S(6), ARGB(ui.pal->ghostHover, 255));
        strokeRounded(g, bx + 0.5f, by + 0.5f, bw - 1, bh - 1, S(6), S(1), ARGB(ui.pal->border, 255));
      }
      if (ui.focus == i) strokeRounded(g, bx - S(3), by - S(3), bw + S(6), bh + S(6), S(8), S(2), ARGB(ui.pal->accent, 255));
    }
  } else {
    /* The bar: a track, and a segment crossing it. Still when the system says no animation. */
    float tx = S(PAD), ty = S(HEIGHT - PAD - 4), tw = S(WIDTH - 2 * PAD), th = S(4);
    fillRounded(g, tx, ty, tw, th, th / 2, ARGB(ui.pal->track, 255));
    if (ui.motion) {
      float t = (float)((GetTickCount64() - ui.start) % 1600) / 1600.0f;
      float seg = tw * 0.32f;
      float x = -seg + (tw + seg) * easeInOut(t);
      float left = x < 0 ? 0 : x, right = x + seg > tw ? tw : x + seg;
      if (right > left) fillRounded(g, tx + left, ty, right - left, th, th / 2, ARGB(ui.pal->accent, 255));
    } else {
      fillRounded(g, tx, ty, tw, th, th / 2, ARGB(ui.pal->accent, 110));
    }
  }
  GdipDeleteGraphics(g);

  SetBkMode(dc, TRANSPARENT);
  HGDIOBJ oldFont = SelectObject(dc, ui.fontMark);
  SetTextColor(dc, ui.pal->text);
  RECT mark = { SI(PAD + 28 + 9), SI(PAD), w - SI(PAD), SI(PAD + 28) };
  DrawTextW(dc, L"debrowser", -1, &mark, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);

  SelectObject(dc, ui.fontTitle);
  RECT title = { SI(PAD), SI(78), w - SI(PAD), SI(106) };
  DrawTextW(dc, titleText(), -1, &title, DT_LEFT | DT_TOP | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS);

  SelectObject(dc, ui.fontBody);
  SetTextColor(dc, ui.pal->dim);
  RECT body = { SI(PAD), SI(108), w - SI(PAD), SI(150) };
  DrawTextW(dc, bodyText(), -1, &body, DT_LEFT | DT_TOP | DT_WORDBREAK | DT_NOPREFIX);

  if (ui.asking) {
    SelectObject(dc, ui.fontButton);
    for (int i = 0; i < 2; i++) {
      SetTextColor(dc, i == 1 ? RGB(0xff, 0xff, 0xff) : ui.pal->text);
      DrawTextW(dc, BUTTON_TEXT[i], -1, &ui.buttons[i], DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    }
  }
  SelectObject(dc, oldFont);

  BitBlt(target, 0, 0, w, h, dc, 0, 0, SRCCOPY);
  SelectObject(dc, oldBmp);
  DeleteObject(bmp);
  DeleteDC(dc);
}

/* ---- Behaviour ----------------------------------------------------------- */

static int buttonAt(int x, int y) {
  POINT p = { x, y };
  if (!ui.asking) return -1;
  for (int i = 0; i < 2; i++) if (PtInRect(&ui.buttons[i], p)) return i;
  return -1;
}

static void fadeOutAndQuit(void) {
  if (!IsWindowVisible(ui.hwnd)) { PostQuitMessage(0); return; }
  KillTimer(ui.hwnd, TIMER_FRAME);
  AnimateWindow(ui.hwnd, ui.motion ? 160 : 1, AW_BLEND | AW_HIDE);
  DestroyWindow(ui.hwnd);
}

/* Asked by the installer; answered when a button is chosen. Messages keep
   flowing meanwhile, so the window stays alive under the question. */
static LRESULT ask(void) {
  ui.asking = TRUE;
  ui.answer = -1;
  ui.focus = 1;
  ui.hover = ui.pressed = -1;
  KillTimer(ui.hwnd, TIMER_FRAME);
  InvalidateRect(ui.hwnd, NULL, FALSE);
  SetForegroundWindow(ui.hwnd);
  FlashWindow(ui.hwnd, TRUE);
  MSG msg;
  while (ui.answer < 0 && GetMessageW(&msg, NULL, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  int answer = ui.answer > 0;
  ui.asking = FALSE;
  ui.start = GetTickCount64();
  if (answer) {
    if (ui.motion) SetTimer(ui.hwnd, TIMER_FRAME, 16, NULL);
    InvalidateRect(ui.hwnd, NULL, FALSE);
  }
  /* Cancelled: the installer quits, and this window with it - see the parent wait in main. */
  return answer;
}

static LRESULT CALLBACK proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
  case WM_PAINT: {
    PAINTSTRUCT ps;
    HDC dc = BeginPaint(hwnd, &ps);
    paint(dc);
    EndPaint(hwnd, &ps);
    return 0;
  }
  case WM_PRINTCLIENT:   /* AnimateWindow draws the fade from this */
    paint((HDC)wp);
    return 0;
  case WM_ERASEBKGND:
    return 1;
  case WM_TIMER:
    InvalidateRect(hwnd, NULL, FALSE);
    return 0;
  case WM_NCHITTEST: {
    /* Dragged anywhere but a button, like any window with no title bar. */
    POINT p = { (short)LOWORD(lp), (short)HIWORD(lp) };
    ScreenToClient(hwnd, &p);
    return buttonAt(p.x, p.y) >= 0 ? HTCLIENT : HTCAPTION;
  }
  case WM_MOUSEMOVE: {
    int at = buttonAt((short)LOWORD(lp), (short)HIWORD(lp));
    if (at != ui.hover) {
      ui.hover = at;
      TRACKMOUSEEVENT track = { sizeof track, TME_LEAVE, hwnd, 0 };
      TrackMouseEvent(&track);
      InvalidateRect(hwnd, NULL, FALSE);
    }
    return 0;
  }
  case WM_MOUSELEAVE:
    ui.hover = -1;
    InvalidateRect(hwnd, NULL, FALSE);
    return 0;
  case WM_LBUTTONDOWN:
    ui.pressed = buttonAt((short)LOWORD(lp), (short)HIWORD(lp));
    if (ui.pressed >= 0) SetCapture(hwnd);
    InvalidateRect(hwnd, NULL, FALSE);
    return 0;
  case WM_LBUTTONUP: {
    int at = buttonAt((short)LOWORD(lp), (short)HIWORD(lp));
    if (GetCapture() == hwnd) ReleaseCapture();
    if (at >= 0 && at == ui.pressed) ui.answer = at;
    ui.pressed = -1;
    InvalidateRect(hwnd, NULL, FALSE);
    return 0;
  }
  case WM_KEYDOWN:
    if (!ui.asking) return 0;
    if (wp == VK_ESCAPE) ui.answer = 0;
    else if (wp == VK_RETURN || wp == VK_SPACE) ui.answer = ui.focus;
    else if (wp == VK_TAB || wp == VK_LEFT || wp == VK_RIGHT) { ui.focus = !ui.focus; InvalidateRect(hwnd, NULL, FALSE); }
    return 0;
  case WM_CLOSE:   /* Alt+F4: under the question it is Cancel; otherwise the install carries on */
    if (ui.asking) ui.answer = 0;
    return 0;
  case WM_DPICHANGED: {
    RECT *want = (RECT *)lp;
    ui.dpi = HIWORD(wp);
    makeFonts();
    SetWindowPos(hwnd, NULL, want->left, want->top, want->right - want->left, want->bottom - want->top,
                 SWP_NOZORDER | SWP_NOACTIVATE);
    return 0;
  }
  case SETUP_UI_ASK:
    return ask();
  case SETUP_UI_DONE:
    fadeOutAndQuit();
    return 0;
  case WM_DESTROY:
    PostQuitMessage(0);
    return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

/* The installer's own icon, for the taskbar button: this file has none of its own. */
static void borrowIcon(HANDLE parent) {
  wchar_t exe[MAX_PATH];
  DWORD len = MAX_PATH;
  if (!parent || !QueryFullProcessImageNameW(parent, 0, exe, &len)) return;
  HICON big = NULL, small = NULL;
  if (ExtractIconExW(exe, 0, &big, &small, 1) == 0) return;
  if (big) SendMessageW(ui.hwnd, WM_SETICON, ICON_BIG, (LPARAM)big);
  if (small) SendMessageW(ui.hwnd, WM_SETICON, ICON_SMALL, (LPARAM)small);
}

/*
 * NSIS deletes its plugins folder as it exits - while this, started from it,
 * may still be fading out, so this file and the folder are left behind in
 * %TEMP%. Removed a moment later by a hidden cmd: this file, then the folder
 * if it is empty, and only a folder named as NSIS names them.
 */
static void removeSelfLater(void) {
  wchar_t self[MAX_PATH], dir[MAX_PATH], cmd[3 * MAX_PATH + 128];
  if (!GetModuleFileNameW(NULL, self, MAX_PATH)) return;
  wcscpy(dir, self);
  wchar_t *slash = wcsrchr(dir, L'\\');
  if (!slash) return;
  *slash = 0;
  const wchar_t *name = wcsrchr(dir, L'\\');
  name = name ? name + 1 : dir;
  size_t n = wcslen(name);
  if (n < 6 || _wcsnicmp(name, L"ns", 2) != 0 || _wcsicmp(name + n - 4, L".tmp") != 0) return;
  _snwprintf(cmd, sizeof cmd / sizeof *cmd,
             L"cmd.exe /d /c ping -n 3 127.0.0.1 >nul & del /f /q \"%ls\" & rmdir \"%ls\"", self, dir);
  cmd[sizeof cmd / sizeof *cmd - 1] = 0;
  STARTUPINFOW si;
  ZeroMemory(&si, sizeof si);
  si.cb = sizeof si;
  PROCESS_INFORMATION pi;
  if (CreateProcessW(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW | DETACHED_PROCESS, NULL, NULL, &si, &pi)) {
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
  }
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE prev, LPSTR line, int show) {
  (void)prev; (void)line; (void)show;
  int argc = 0;
  wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv || argc < 3) return 2;
  ui.mode = _wcsicmp(argv[1], L"uninstall") == 0 ? MODE_UNINSTALL : MODE_INSTALL;
  DWORD pid = (DWORD)wcstoul(argv[2], NULL, 10);
  LocalFree(argv);
  /* No installer to follow, no window: it would never be told to close. */
  HANDLE parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!parent) return 3;

  becomeDpiAware();
  ULONG_PTR gdiplus = 0;
  GdiplusStartupInput gin = { 1, NULL, FALSE, FALSE };
  if (GdiplusStartup(&gdiplus, &gin, NULL) != 0) return 4;

  ui.pal = lightTheme() ? &LIGHT : &DARK;
  BOOL animations = TRUE;
  SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &animations, 0);
  ui.motion = animations;
  ui.hover = ui.pressed = ui.focus = -1;
  ui.start = GetTickCount64();

  WNDCLASSEXW wc;
  ZeroMemory(&wc, sizeof wc);
  wc.cbSize = sizeof wc;
  wc.style = CS_DROPSHADOW;
  wc.lpfnWndProc = proc;
  wc.hInstance = instance;
  wc.hCursor = LoadCursorW(NULL, (LPCWSTR)IDC_ARROW);
  wc.lpszClassName = SETUP_UI_CLASS;
  RegisterClassExW(&wc);

  /* Centred on the screen the pointer is on: where the installer was opened. */
  POINT cursor;
  GetCursorPos(&cursor);
  MONITORINFO mi;
  ZeroMemory(&mi, sizeof mi);
  mi.cbSize = sizeof mi;
  GetMonitorInfoW(MonitorFromPoint(cursor, MONITOR_DEFAULTTOPRIMARY), &mi);
  ui.hwnd = CreateWindowExW(WS_EX_APPWINDOW, SETUP_UI_CLASS,
                            ui.mode == MODE_INSTALL ? L"Debrowser Setup" : L"Uninstall Debrowser",
                            WS_POPUP | WS_SYSMENU | WS_MINIMIZEBOX, mi.rcWork.left, mi.rcWork.top, 1, 1,
                            NULL, NULL, instance, NULL);
  if (!ui.hwnd) return 5;
  ui.dpi = dpiOf(ui.hwnd);
  makeFonts();
  int w = SI(WIDTH), h = SI(HEIGHT);
  int x = mi.rcWork.left + (mi.rcWork.right - mi.rcWork.left - w) / 2;
  int y = mi.rcWork.top + (mi.rcWork.bottom - mi.rcWork.top - h) / 2;
  SetWindowPos(ui.hwnd, NULL, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
  ui.dwmEdge = roundCorners(ui.hwnd, ui.pal->border);
  borrowIcon(parent);

  AnimateWindow(ui.hwnd, ui.motion ? 180 : 1, AW_BLEND | AW_ACTIVATE);
  SetForegroundWindow(ui.hwnd);
  if (ui.motion) SetTimer(ui.hwnd, TIMER_FRAME, 16, NULL);

  /* Until the installer is gone or says it is done. */
  MSG msg;
  for (;;) {
    DWORD woke = MsgWaitForMultipleObjects(1, &parent, FALSE, INFINITE, QS_ALLINPUT);
    if (woke == WAIT_OBJECT_0) {
      if (IsWindow(ui.hwnd)) fadeOutAndQuit();
      break;
    }
    BOOL quit = FALSE;
    while (PeekMessageW(&msg, NULL, 0, 0, PM_REMOVE)) {
      if (msg.message == WM_QUIT) { quit = TRUE; break; }
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
    if (quit) break;
  }
  CloseHandle(parent);
  GdiplusShutdown(gdiplus);
  removeSelfLater();
  return 0;
}
