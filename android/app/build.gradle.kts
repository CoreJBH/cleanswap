plugins {
    id("com.android.application")
}

android {
    namespace = "com.jbitmstr.cleanswap"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.jbitmstr.cleanswap"
        minSdk = 24
        targetSdk = 34
        versionCode = 7
        versionName = "0.5.0"
        resourceConfigurations += listOf("en", "ko")
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
        }
        getByName("release") {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // No dependencies: the shell is a plain android.webkit.WebView over the
    // single-file app staged into src/main/assets/index.html by CI.
}

tasks.register<Copy>("stageWebApp") {
    description = "Copy the built single-file app into the APK assets."
    from(rootProject.file("../dist/cleanswap.html"))
    into(layout.projectDirectory.dir("src/main/assets"))
    rename { "index.html" }
}
