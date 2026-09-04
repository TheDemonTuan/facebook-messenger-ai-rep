import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { OverviewPage } from "./pages/OverviewPage";
import { InboxPage } from "./pages/InboxPage";
import { ConversationDetailPage } from "./pages/ConversationDetailPage";
import { QueuePage } from "./pages/QueuePage";
import { IncidentsPage } from "./pages/IncidentsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { AuditPage } from "./pages/AuditPage";
import { SessionConsolePage } from "./pages/SessionConsolePage";
import { LoginPage } from "./pages/LoginPage";

export const App: React.FC = () => {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        {/* Protected layout routes */}
        <Route
          path="/overview"
          element={
            <Layout>
              <OverviewPage />
            </Layout>
          }
        />
        <Route
          path="/inbox"
          element={
            <Layout>
              <InboxPage />
            </Layout>
          }
        />
        <Route
          path="/inbox/:conversationId"
          element={
            <Layout>
              <ConversationDetailPage />
            </Layout>
          }
        />
        <Route
          path="/queue"
          element={
            <Layout>
              <QueuePage />
            </Layout>
          }
        />
        <Route
          path="/incidents"
          element={
            <Layout>
              <IncidentsPage />
            </Layout>
          }
        />
        <Route
          path="/settings"
          element={
            <Layout>
              <SettingsPage />
            </Layout>
          }
        />
        <Route
          path="/audit"
          element={
            <Layout>
              <AuditPage />
            </Layout>
          }
        />
        <Route
          path="/session"
          element={
            <Layout>
              <SessionConsolePage />
            </Layout>
          }
        />

        {/* Fallback redirect */}
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Routes>
    </BrowserRouter>
  );
};
