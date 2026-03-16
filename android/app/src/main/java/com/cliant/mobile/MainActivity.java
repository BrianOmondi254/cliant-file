package com.cliant.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.WebViewDirection;
import java.util.ArrayList;
import java.util.Arrays;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Load the production URL
        this.getBridge().getWebView().loadUrl("https://tbank-8sid.onrender.com");
    }
}
