{
  "targets": [
    {
      "target_name": "streamview",
      "conditions": [
        ["OS=='win'", {
          "sources": ["src/streamview_win.cc"],
          "include_dirs": ["<(module_root_dir)/sdk/include"],
          "libraries": [
            "<(module_root_dir)/sdk/x64/WebView2LoaderStatic.lib",
            "version.lib", "advapi32.lib", "ole32.lib", "shlwapi.lib", "user32.lib"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": { "ExceptionHandling": 1, "AdditionalOptions": ["/std:c++17"] }
          }
        }],
        ["OS=='mac'", {
          "sources": ["src/streamview_mac.mm"],
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "MACOSX_DEPLOYMENT_TARGET": "11.0"
          },
          "link_settings": { "libraries": ["-framework Cocoa", "-framework WebKit"] }
        }]
      ]
    }
  ]
}
