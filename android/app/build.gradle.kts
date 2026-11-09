plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.dk1mi.websdrradiosync"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.dk1mi.websdrradiosync"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
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
    from(rootProject.projectDir.parentFile) {
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
