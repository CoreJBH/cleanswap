import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
}

/* Release signing — fail closed.
 *
 * The long-lived key comes from CLEANSWAP_KEYSTORE / CLEANSWAP_KEYSTORE_PASSWORD /
 * CLEANSWAP_KEY_ALIAS / CLEANSWAP_KEY_PASSWORD (environment, CI repository secrets) or
 * from android/keystore.properties (git-ignored, local). When any of the four is
 * missing, a task that packages a release stops with an error that names what is
 * missing instead of producing an APK signed with a debug key: that APK installs, but
 * it can never update a released one, and nothing in its name says which key signed it.
 * assembleDebug, lint and the tests never touch this.
 */
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        FileInputStream(keystorePropertiesFile).use { load(it) }
    }
}

fun signingValue(name: String): String? =
    (System.getenv(name) ?: keystoreProperties.getProperty(name))?.trim()?.takeIf { it.isNotEmpty() }

val releaseStoreFile = signingValue("CLEANSWAP_KEYSTORE")
val releaseStorePassword = signingValue("CLEANSWAP_KEYSTORE_PASSWORD")
val releaseKeyAlias = signingValue("CLEANSWAP_KEY_ALIAS")
val releaseKeyPassword = signingValue("CLEANSWAP_KEY_PASSWORD")

val missingSigning = buildList {
    if (releaseStoreFile == null) add("CLEANSWAP_KEYSTORE (path to the release .jks/.keystore)")
    if (releaseStorePassword == null) add("CLEANSWAP_KEYSTORE_PASSWORD")
    if (releaseKeyAlias == null) add("CLEANSWAP_KEY_ALIAS")
    if (releaseKeyPassword == null) add("CLEANSWAP_KEY_PASSWORD")
}
/* The path is read from the android/ project, not from this module, so
 * `keystore/cleanswap-release.jks` means android/keystore/... */
val releaseStore = releaseStoreFile?.let { rootProject.file(it) }
val releaseStoreMissing = releaseStore != null && !releaseStore.exists()
val hasReleaseSigning = missingSigning.isEmpty() && !releaseStoreMissing

/* A builder that signs the artifact with its own key asks for an unsigned release
 * APK explicitly: -Pcleanswap.unsignedRelease=true. F-Droid builds
 * assembleRelease in a checkout that has no keystore and signs the APK it gets
 * with the F-Droid key, so for that builder the missing key is not an error.
 * Nothing infers it from the absence of a key, the default stays strict, and the
 * debug key is still never used: an unsigned build produces
 * app-release-unsigned.apk and nothing else. */
val unsignedReleaseRequested =
    providers.gradleProperty("cleanswap.unsignedRelease").orNull?.equals("true", ignoreCase = true) == true

android {
    namespace = "com.corejbh.cleanswap"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.corejbh.cleanswap"
        minSdk = 24
        targetSdk = 34
        versionCode = 22
        versionName = "0.6.13"
        resourceConfigurations += listOf("en", "ko")
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = releaseStore
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                /* minSdk 24 devices verify APK Signature Scheme v2; an extra v1
                   (JAR) signature over the same files would only add a second,
                   weaker digest to check. */
                enableV1Signing = false
                enableV2Signing = true
            }
        }
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
        }
        getByName("release") {
            /* A release build is the bytes a person installs: shrink and
               obfuscate it, with the rules that keep the shell's entry points. */
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = true
            isShrinkResources = true
            /* Said out loud, not left to the default: a release APK carries no
               debug flag, so the system never lets a debugger attach to it. */
            isDebuggable = false
            isJniDebuggable = false
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

/* The gate. Only a task that packages a release needs the key, so assembleDebug,
 * lintDebug and the tests run exactly as before; assembleRelease, bundleRelease and
 * installRelease stop here, before any APK exists, when the key is not configured. */
val releasePackagingTasks = setOf(
    "packageRelease",
    "assembleRelease",
    "bundleRelease",
    "installRelease",
    "packageReleaseBundle",
)

gradle.taskGraph.whenReady {
    val asked = allTasks.map { it.name }.filter { it in releasePackagingTasks }
    if (asked.isEmpty() || hasReleaseSigning || unsignedReleaseRequested) return@whenReady
    val missing = buildList {
        addAll(missingSigning)
        if (releaseStoreMissing) add("a readable keystore file at $releaseStoreFile")
    }
    throw GradleException(
        "release signing is not configured, so the release tasks were stopped:\n" +
            "  asked for: ${asked.joinToString(", ")}\n" +
            "  missing: ${missing.joinToString(", ")}\n" +
            "An APK signed with a debug key installs but can never update a released one, and\n" +
            "nothing in it says which key signed it, so this build will not produce one.\n" +
            "Set the four values as environment variables (CI: repository secrets) or put them in\n" +
            "android/keystore.properties (git-ignored):\n" +
            "  CLEANSWAP_KEYSTORE=/path/to/release.jks\n" +
            "  CLEANSWAP_KEYSTORE_PASSWORD=…\n" +
            "  CLEANSWAP_KEY_ALIAS=…\n" +
            "  CLEANSWAP_KEY_PASSWORD=…\n" +
            "For a local or debug build use :app:assembleDebug, which needs no key.\n" +
            "A builder that signs the artifact with its own key (F-Droid) passes\n" +
            "-Pcleanswap.unsignedRelease=true and gets an unsigned release APK."
    )
}
