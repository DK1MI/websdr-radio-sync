import groovy.json.JsonSlurper
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val extensionDir: File = rootProject.projectDir.parentFile

// One version for extension and app: manifest.json "version" (2.3.0 -> versionCode 20300).
val extVersion = (JsonSlurper().parse(File(extensionDir, "manifest.json")) as Map<*, *>)["version"] as String
val extVersionCode = extVersion.split(".").map { it.toInt() }.let { (a, b, c) -> a * 10000 + b * 100 + c }

// Release signing: ../.secrets/android-keystore.properties (not in git), see README "Android app".
val signingProps = File(extensionDir, ".secrets/android-keystore.properties")
    .takeIf { it.exists() }
    ?.let { f -> Properties().apply { f.inputStream().use { load(it) } } }

android {
    namespace = "io.github.dk1mi.websdrradiosync"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.dk1mi.websdrradiosync"
        minSdk = 26
        targetSdk = 35
        versionCode = extVersionCode
        versionName = extVersion
    }

    signingConfigs {
        if (signingProps != null) create("release") {
            storeFile = File(extensionDir, ".secrets/" + signingProps.getProperty("storeFile"))
            storePassword = signingProps.getProperty("storePassword")
            keyAlias = signingProps.getProperty("keyAlias")
            keyPassword = signingProps.getProperty("keyPassword")
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug" // installs next to the release app
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = false // small app; avoids keep rules for the JS interfaces and USB driver probing
            if (signingProps != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    // The panel, rig drivers and SDR content script come straight from the extension.
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/extAssets"))
}

val copyExtension by tasks.registering(Sync::class) {
    from(extensionDir) {
        include("panel.html", "panel.css", "panel.js", "logbook.js", "spots.js",
            "rigs/**", "content/**", "icons/**")
    }
    into(layout.buildDirectory.dir("generated/extAssets/ext"))
}
tasks.named("preBuild") { dependsOn(copyExtension) }

dependencies {
    implementation("androidx.core:core:1.13.1")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.github.mik3y:usb-serial-for-android:3.8.1")
}
