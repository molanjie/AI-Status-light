package com.miniwatch.codex;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    private static final String PREFS = "mini_watch";
    private static final String KEY_SERVER = "server";
    private static final String DEFAULT_SERVER = "https://steal-position-pontiac-focusing.trycloudflare.com";

    private WebView webView;
    private LinearLayout errorPanel;
    private TextView errorMessage;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        Window window = getWindow();
        window.setStatusBarColor(Color.BLACK);
        window.setNavigationBarColor(Color.BLACK);
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(5, 5, 5));
        webView = new WebView(this);
        errorPanel = createErrorPanel();

        root.addView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        root.addView(errorPanel, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        setContentView(root);

        configureWebView();
        loadDashboard();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        webView.setBackgroundColor(Color.rgb(5, 5, 5));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setLongClickable(true);
        webView.setOnLongClickListener(v -> {
            showServerDialog();
            return true;
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                errorPanel.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showError("连接不到 Mini Watch 服务");
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                view.loadUrl(request.getUrl().toString());
                return true;
            }
        });
    }

    private LinearLayout createErrorPanel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(dp(28), dp(28), dp(28), dp(28));
        panel.setBackgroundColor(Color.rgb(5, 5, 5));
        panel.setVisibility(View.GONE);

        TextView title = new TextView(this);
        title.setText("Codex 红绿灯");
        title.setTextColor(Color.WHITE);
        title.setTextSize(28);
        title.setGravity(Gravity.CENTER);
        title.setTypeface(null, 1);

        errorMessage = new TextView(this);
        errorMessage.setTextColor(Color.rgb(160, 160, 166));
        errorMessage.setTextSize(15);
        errorMessage.setGravity(Gravity.CENTER);
        errorMessage.setText("等待连接");

        Button retry = new Button(this);
        retry.setText("重试");
        retry.setOnClickListener(v -> loadDashboard());

        Button settings = new Button(this);
        settings.setText("修改地址");
        settings.setOnClickListener(v -> showServerDialog());

        panel.addView(title, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        addSpacer(panel, 12);
        panel.addView(errorMessage, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        addSpacer(panel, 22);
        panel.addView(retry, buttonParams());
        addSpacer(panel, 10);
        panel.addView(settings, buttonParams());
        return panel;
    }

    private LinearLayout.LayoutParams buttonParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(48)
        );
        params.setMargins(dp(18), 0, dp(18), 0);
        return params;
    }

    private void addSpacer(LinearLayout panel, int heightDp) {
        View spacer = new View(this);
        panel.addView(spacer, new LinearLayout.LayoutParams(1, dp(heightDp)));
    }

    private void loadDashboard() {
        String server = prefs.getString(KEY_SERVER, DEFAULT_SERVER);
        String url = dashboardUrl(server);
        errorPanel.setVisibility(View.GONE);
        webView.loadUrl(url);
    }

    private String dashboardUrl(String server) {
        String base = normalizeServer(server);
        Uri uri = Uri.parse(base);
        String path = uri.getPath();
        if (path == null || path.length() == 0 || "/".equals(path)) {
            base = trimTrailingSlash(base) + "/phone";
        }
        return appendQuery(base, "app", "android");
    }

    private String normalizeServer(String value) {
        String text = value == null ? "" : value.trim();
        if (text.length() == 0) text = DEFAULT_SERVER;
        if (!text.startsWith("http://") && !text.startsWith("https://")) {
            text = "http://" + text;
        }
        return text;
    }

    private String trimTrailingSlash(String value) {
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        return value;
    }

    private String appendQuery(String url, String key, String value) {
        Uri uri = Uri.parse(url);
        Uri.Builder builder = uri.buildUpon();
        builder.appendQueryParameter(key, value);
        builder.appendQueryParameter("v", String.valueOf(System.currentTimeMillis()));
        return builder.build().toString();
    }

    private void showError(String message) {
        errorMessage.setText(message + "\n\n当前地址：" + normalizeServer(prefs.getString(KEY_SERVER, DEFAULT_SERVER)) + "\n长按页面也可以修改地址。");
        errorPanel.setVisibility(View.VISIBLE);
    }

    private void showServerDialog() {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setText(normalizeServer(prefs.getString(KEY_SERVER, DEFAULT_SERVER)));
        input.setSelectAllOnFocus(true);

        new AlertDialog.Builder(this)
            .setTitle("服务器地址")
            .setMessage("填写电脑的局域网地址，例如：http://192.168.31.194:3001")
            .setView(input)
            .setNegativeButton("取消", null)
            .setPositiveButton("保存", (dialog, which) -> {
                String value = normalizeServer(input.getText().toString());
                prefs.edit().putString(KEY_SERVER, value).apply();
                Toast.makeText(this, "已保存", Toast.LENGTH_SHORT).show();
                loadDashboard();
            })
            .show();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    private int dp(int value) {
        float density = getResources().getDisplayMetrics().density;
        return Math.round(value * density);
    }
}
