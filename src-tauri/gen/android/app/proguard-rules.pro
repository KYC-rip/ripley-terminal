# Preserve Tauri runtime, Wry WebView JNI bindings, and RipleyOS Android host classes
# so R8 minification in release builds never strips or renames JNI / @Command / @InvokeArg targets.
-keep class app.tauri.** { *; }
-keep class run.ripley.terminal.** { *; }

-keepclassmembers class * {
    native <methods>;
}

-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod

-keep @app.tauri.annotation.TauriPlugin class * { *; }
-keep @app.tauri.annotation.InvokeArg class * { *; }
-keepclassmembers class * {
    @app.tauri.annotation.Command <methods>;
}

# Tauri Android Invoke.parseArgs uses Jackson reflection
-keep class com.fasterxml.jackson.** { *; }
-dontwarn com.fasterxml.jackson.**

# Keep biometric / lifecycle ViewModel constructors on release R8 builds
-keep class androidx.biometric.** { *; }
