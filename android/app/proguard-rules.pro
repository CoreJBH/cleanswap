# R8 keeps the shell's entry points. The app is one Activity and the WebView
# client classes inside it; the platform reaches them by name, so shrinking them
# away would leave an installable APK that cannot start.
-keep class com.corejbh.cleanswap.MainActivity { *; }
-keep class com.corejbh.cleanswap.MainActivity$ShellClient { *; }
-keepclassmembers class * extends android.webkit.WebViewClient { *; }
-keepclassmembers class * extends android.webkit.WebChromeClient { *; }

# The page is an asset, not code: nothing in it is obfuscated, and no JavaScript
# interface exists that would need its names kept.
