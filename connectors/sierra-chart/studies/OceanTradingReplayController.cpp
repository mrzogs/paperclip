// Ocean Trading Replay Controller
//
// Replay-only ACSIL bridge for the Sierra Chart connector. This study reads a
// command file written by the Node connector and calls Sierra Chart replay APIs
// from inside the replay instance. Do not load this study on live charts.

#include "sierrachart.h"

#include <algorithm>
#include <cstdlib>
#include <cctype>
#include <fstream>
#include <map>
#include <sstream>
#include <string>

SCDLLName("Ocean Trading Replay Controller")

namespace {

const char* VERSION = "v0.1.11";
const char* DEFAULT_COMMAND_PATH = "D:\\Trading\\SierraChart-Replay\\connector-control\\replay-command.json";
const char* DEFAULT_STATUS_PATH = "D:\\Trading\\SierraChart-Replay\\connector-control\\replay-status.json";

struct StudyInputOverrides
{
    std::string StudyName;
    std::map<int, int> IntInputs;
    std::map<int, double> FloatInputs;
    std::map<int, std::string> StringInputs;
};

std::string ReadTextFile(const SCString& path)
{
    std::ifstream input(path.GetChars(), std::ios::in | std::ios::binary);
    if (!input.is_open())
        return "";

    std::ostringstream buffer;
    buffer << input.rdbuf();
    return buffer.str();
}

void WriteTextFile(const SCString& path, const std::string& text)
{
    std::ofstream output(path.GetChars(), std::ios::out | std::ios::binary | std::ios::trunc);
    if (output.is_open())
        output << text;
}

std::string JsonEscape(const std::string& value)
{
    std::string escaped;
    for (char ch : value)
    {
        if (ch == '"' || ch == '\\')
        {
            escaped.push_back('\\');
            escaped.push_back(ch);
        }
        else if (ch == '\n')
        {
            escaped += "\\n";
        }
        else if (ch == '\r')
        {
            escaped += "\\r";
        }
        else
        {
            escaped.push_back(ch);
        }
    }
    return escaped;
}

std::string ExtractJsonString(const std::string& json, const char* key)
{
    const std::string marker = std::string("\"") + key + "\"";
    const size_t keyPos = json.find(marker);
    if (keyPos == std::string::npos)
        return "";

    const size_t colonPos = json.find(':', keyPos + marker.size());
    if (colonPos == std::string::npos)
        return "";

    size_t firstQuote = colonPos + 1;
    while (firstQuote < json.size() && (json[firstQuote] == ' ' || json[firstQuote] == '\t' || json[firstQuote] == '\r' || json[firstQuote] == '\n'))
        ++firstQuote;

    if (firstQuote >= json.size() || json[firstQuote] != '"')
        return "";

    std::string value;
    bool escaped = false;
    for (size_t index = firstQuote + 1; index < json.size(); ++index)
    {
        const char ch = json[index];
        if (escaped)
        {
            value.push_back(ch);
            escaped = false;
        }
        else if (ch == '\\')
        {
            escaped = true;
        }
        else if (ch == '"')
        {
            return value;
        }
        else
        {
            value.push_back(ch);
        }
    }
    return "";
}

int ExtractJsonInt(const std::string& json, const char* key, const int fallback)
{
    const std::string marker = std::string("\"") + key + "\"";
    const size_t keyPos = json.find(marker);
    if (keyPos == std::string::npos)
        return fallback;

    const size_t colonPos = json.find(':', keyPos + marker.size());
    if (colonPos == std::string::npos)
        return fallback;

    size_t valueStart = colonPos + 1;
    while (valueStart < json.size() && (json[valueStart] == ' ' || json[valueStart] == '\t'))
        ++valueStart;

    return std::atoi(json.c_str() + valueStart);
}

bool ExtractJsonBool(const std::string& json, const char* key, const bool fallback)
{
    const std::string marker = std::string("\"") + key + "\"";
    const size_t keyPos = json.find(marker);
    if (keyPos == std::string::npos)
        return fallback;

    const size_t colonPos = json.find(':', keyPos + marker.size());
    if (colonPos == std::string::npos)
        return fallback;

    size_t valueStart = colonPos + 1;
    while (valueStart < json.size() && (json[valueStart] == ' ' || json[valueStart] == '\t'))
        ++valueStart;

    return json.compare(valueStart, 4, "true") == 0;
}

std::string ExtractJsonObject(const std::string& json, const char* key)
{
    const std::string marker = std::string("\"") + key + "\"";
    const size_t keyPos = json.find(marker);
    if (keyPos == std::string::npos)
        return "";

    const size_t colonPos = json.find(':', keyPos + marker.size());
    if (colonPos == std::string::npos)
        return "";

    size_t valueStart = colonPos + 1;
    while (valueStart < json.size() && (json[valueStart] == ' ' || json[valueStart] == '\t' || json[valueStart] == '\r' || json[valueStart] == '\n'))
        ++valueStart;

    if (valueStart >= json.size() || json[valueStart] != '{')
        return "";

    int depth = 0;
    bool inString = false;
    bool escaped = false;
    for (size_t index = valueStart; index < json.size(); ++index)
    {
        const char ch = json[index];
        if (inString)
        {
            if (escaped)
                escaped = false;
            else if (ch == '\\')
                escaped = true;
            else if (ch == '"')
                inString = false;
            continue;
        }

        if (ch == '"')
        {
            inString = true;
            continue;
        }
        if (ch == '{')
            ++depth;
        else if (ch == '}')
        {
            --depth;
            if (depth == 0)
                return json.substr(valueStart, index - valueStart + 1);
        }
    }
    return "";
}

void ParseNumericMapObject(const std::string& json, std::map<int, double>& output)
{
    size_t searchFrom = 0;
    while (searchFrom < json.size())
    {
        const size_t keyStart = json.find('"', searchFrom);
        if (keyStart == std::string::npos)
            break;
        const size_t keyEnd = json.find('"', keyStart + 1);
        if (keyEnd == std::string::npos)
            break;
        const std::string keyText = json.substr(keyStart + 1, keyEnd - keyStart - 1);
        const size_t colonPos = json.find(':', keyEnd + 1);
        if (colonPos == std::string::npos)
            break;

        size_t valueStart = colonPos + 1;
        while (valueStart < json.size() && (json[valueStart] == ' ' || json[valueStart] == '\t' || json[valueStart] == '\r' || json[valueStart] == '\n'))
            ++valueStart;

        char* endPtr = nullptr;
        const double value = std::strtod(json.c_str() + valueStart, &endPtr);
        if (endPtr != nullptr && endPtr != json.c_str() + valueStart)
        {
            output[std::atoi(keyText.c_str())] = value;
            searchFrom = static_cast<size_t>(endPtr - json.c_str());
        }
        else
        {
            searchFrom = keyEnd + 1;
        }
    }
}

void ParseStringMapObject(const std::string& json, std::map<int, std::string>& output)
{
    size_t searchFrom = 0;
    while (searchFrom < json.size())
    {
        const size_t keyStart = json.find('"', searchFrom);
        if (keyStart == std::string::npos)
            break;
        const size_t keyEnd = json.find('"', keyStart + 1);
        if (keyEnd == std::string::npos)
            break;

        const std::string keyText = json.substr(keyStart + 1, keyEnd - keyStart - 1);
        const int key = std::atoi(keyText.c_str());
        const size_t colonPos = json.find(':', keyEnd + 1);
        if (colonPos == std::string::npos)
            break;

        size_t valueStart = colonPos + 1;
        while (valueStart < json.size() && (json[valueStart] == ' ' || json[valueStart] == '\t' || json[valueStart] == '\r' || json[valueStart] == '\n'))
            ++valueStart;

        if (valueStart >= json.size() || json[valueStart] != '"')
        {
            searchFrom = valueStart + 1;
            continue;
        }

        std::ostringstream value;
        bool escaped = false;
        for (size_t index = valueStart + 1; index < json.size(); ++index)
        {
            const char ch = json[index];
            if (escaped)
            {
                value << ch;
                escaped = false;
                continue;
            }
            if (ch == '\\')
            {
                escaped = true;
                continue;
            }
            if (ch == '"')
            {
                output[key] = value.str();
                searchFrom = index + 1;
                break;
            }
        }
    }
}

StudyInputOverrides ExtractStudyInputOverrides(const std::string& json)
{
    StudyInputOverrides overrides;
    const std::string root = ExtractJsonObject(json, "studyInputOverrides");
    if (root.empty())
        return overrides;

    overrides.StudyName = ExtractJsonString(root, "studyName");

    const std::string intInputsObject = ExtractJsonObject(root, "intInputs");
    std::map<int, double> intInputsRaw;
    ParseNumericMapObject(intInputsObject, intInputsRaw);
    for (const auto& entry : intInputsRaw)
        overrides.IntInputs[entry.first] = static_cast<int>(entry.second);

    const std::string floatInputsObject = ExtractJsonObject(root, "floatInputs");
    ParseNumericMapObject(floatInputsObject, overrides.FloatInputs);
    const std::string stringInputsObject = ExtractJsonObject(root, "stringInputs");
    ParseStringMapObject(stringInputsObject, overrides.StringInputs);
    return overrides;
}

bool ParseDateTime(const std::string& text, SCDateTime& output)
{
    int year = 0;
    int month = 0;
    int day = 0;
    int hour = 0;
    int minute = 0;
    int second = 0;
    if (std::sscanf(text.c_str(), "%d-%d-%d %d:%d:%d", &year, &month, &day, &hour, &minute, &second) != 6
        && std::sscanf(text.c_str(), "%d/%d/%d %d:%d:%d", &year, &month, &day, &hour, &minute, &second) != 6)
        return false;

    output.SetDateTimeYMDHMS(year, month, day, hour, minute, second);
    return true;
}

std::string DateTimeToText(const SCDateTime& value)
{
    int year = 0;
    int month = 0;
    int day = 0;
    int hour = 0;
    int minute = 0;
    int second = 0;
    value.GetDateYMD(year, month, day);
    value.GetTimeHMS(hour, minute, second);

    char buffer[32] = {};
    std::snprintf(buffer, sizeof(buffer), "%04d-%02d-%02d %02d:%02d:%02d", year, month, day, hour, minute, second);
    return buffer;
}

bool IsValidReplayDateTime(const SCDateTime& value)
{
    int year = 0;
    int month = 0;
    int day = 0;
    value.GetDateYMD(year, month, day);
    return year >= 2000;
}

SCDateTime ReplayAwareCurrentDateTime(SCStudyInterfaceRef sc)
{
    if (sc.IsReplayRunning())
        return sc.CurrentDateTimeForReplay;

    if (sc.ArraySize > 0)
        return sc.BaseDateTimeIn[sc.ArraySize - 1];

    SCDateTime empty;
    empty.Clear();
    return empty;
}

int ReplayStatusForChart(SCStudyInterfaceRef sc, const int chartNumber)
{
    const int targetChartStatus = sc.GetReplayStatusFromChart(chartNumber);
    if (targetChartStatus != REPLAY_STOPPED)
        return targetChartStatus;
    return sc.ReplayStatus;
}

bool ReplayIsActivelyRunning(SCStudyInterfaceRef sc, const int chartNumber)
{
    return ReplayStatusForChart(sc, chartNumber) == REPLAY_RUNNING;
}

bool ReplayIsPaused(SCStudyInterfaceRef sc, const int chartNumber)
{
    return ReplayStatusForChart(sc, chartNumber) == REPLAY_PAUSED;
}

bool ChartDataReadyForReplayStart(SCStudyInterfaceRef sc, const int chartNumber, std::string& detail)
{
    const bool allChartsLoaded = sc.IsChartDataLoadingCompleteForAllCharts() != 0;
    const bool targetChartDownloading = sc.ChartIsDownloadingHistoricalData(chartNumber) != 0;
    const bool currentChartDownloading = sc.DownloadingHistoricalData != 0;
    const bool fullRecalculation = sc.IsFullRecalculation != 0;

    std::ostringstream status;
    status
        << "all_charts_loaded=" << (allChartsLoaded ? "yes" : "no")
        << "; target_chart_downloading=" << (targetChartDownloading ? "yes" : "no")
        << "; current_chart_downloading=" << (currentChartDownloading ? "yes" : "no")
        << "; full_recalc=" << (fullRecalculation ? "yes" : "no");
    detail = status.str();

    return allChartsLoaded && !targetChartDownloading && !currentChartDownloading && !fullRecalculation;
}

std::string LowerAscii(std::string value)
{
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return value;
}

int FindStudyIdByName(SCStudyInterfaceRef sc, const int chartNumber, const std::string& requestedName, std::string& detail)
{
    int studyId = sc.GetStudyIDByName(chartNumber, requestedName.c_str(), 0);
    if (studyId > 0)
    {
        detail = "matched exact graph name";
        return studyId;
    }

    studyId = sc.GetStudyIDByName(chartNumber, requestedName.c_str(), 1);
    if (studyId > 0)
    {
        detail = "matched short name";
        return studyId;
    }

    const std::string requestedLower = LowerAscii(requestedName);
    std::ostringstream seen;
    bool firstSeen = true;
    for (int candidateId = 1; candidateId <= 200; ++candidateId)
    {
        const SCString chartStudyName = sc.GetStudyNameFromChart(chartNumber, candidateId);
        const std::string candidateName = chartStudyName.GetChars();
        if (candidateName.empty())
            continue;

        if (!firstSeen)
            seen << "; ";
        seen << candidateId << ":" << candidateName;
        firstSeen = false;

        const std::string candidateLower = LowerAscii(candidateName);
        if (candidateLower.find(requestedLower) != std::string::npos || requestedLower.find(candidateLower) != std::string::npos)
        {
            detail = "matched by scanning chart studies: " + candidateName;
            return candidateId;
        }
    }

    detail = "seen studies: " + seen.str();
    return 0;
}

SCString DefaultControlDir(SCStudyInterfaceRef sc)
{
    return "D:\\Trading\\SierraChart-Replay\\connector-control";
}

void WriteStatus(
    SCStudyInterfaceRef sc,
    const SCString& statusPath,
    const std::string& commandId,
    const std::string& action,
    const std::string& requestedStart,
    const std::string& requestedEnd,
    const std::string& replaySpeed,
    const std::string& status,
    const std::string& error,
    const std::string& detail = "")
{
    SCDateTime currentDateTime = ReplayAwareCurrentDateTime(sc);
    const int chartReplayStatus = sc.GetReplayStatusFromChart(sc.ChartNumber);
    const std::string effectiveStart =
        action == "start" && !requestedStart.empty() && chartReplayStatus == REPLAY_RUNNING
            ? DateTimeToText(currentDateTime)
            : "";
    std::ostringstream json;
    json
        << "{\n"
        << "  \"schema\": \"ocean-trading.sierra-replay-controller.status.v1\",\n"
        << "  \"controllerVersion\": \"" << VERSION << "\",\n"
        << "  \"commandId\": \"" << JsonEscape(commandId) << "\",\n"
        << "  \"action\": \"" << JsonEscape(action) << "\",\n"
        << "  \"status\": \"" << JsonEscape(status) << "\",\n"
        << "  \"chartNumber\": " << sc.ChartNumber << ",\n"
        << "  \"requestedStartDateTime\": \"" << JsonEscape(requestedStart) << "\",\n"
        << "  \"requestedEndDateTime\": \"" << JsonEscape(requestedEnd) << "\",\n"
        << "  \"effectiveStartDateTime\": " << (effectiveStart.empty() ? "null" : ("\"" + JsonEscape(effectiveStart) + "\"")) << ",\n"
        << "  \"currentChartDateTime\": \"" << JsonEscape(DateTimeToText(currentDateTime)) << "\",\n"
        << "  \"replaySpeed\": \"" << JsonEscape(replaySpeed) << "\",\n"
        << "  \"isReplayRunning\": " << (sc.IsReplayRunning() ? "true" : "false") << ",\n"
        << "  \"replayStatus\": " << sc.ReplayStatus << ",\n"
        << "  \"chartReplayStatus\": " << chartReplayStatus << ",\n"
        << "  \"detail\": " << (detail.empty() ? "null" : ("\"" + JsonEscape(detail) + "\"")) << ",\n"
        << "  \"error\": " << (error.empty() ? "null" : ("\"" + JsonEscape(error) + "\"")) << "\n"
        << "}\n";
    WriteTextFile(statusPath, json.str());
}

bool ApplyStudyInputOverrides(
    SCStudyInterfaceRef sc,
    const int chartNumber,
    const StudyInputOverrides& overrides,
    std::string& detail,
    std::string& error)
{
    if (overrides.StudyName.empty())
    {
        error = "studyInputOverrides.studyName is required";
        return false;
    }

    std::string lookupDetail;
    const int studyId = FindStudyIdByName(sc, chartNumber, overrides.StudyName, lookupDetail);
    if (studyId <= 0)
    {
        error = "Unable to find target study by name: " + overrides.StudyName + ". " + lookupDetail;
        return false;
    }

    std::ostringstream applied;
    applied << lookupDetail;
    bool first = lookupDetail.empty();
    for (const auto& entry : overrides.IntInputs)
    {
        const int result = sc.SetChartStudyInputInt(chartNumber, studyId, entry.first, entry.second);
        if (result == 0)
        {
            error = "Failed to apply integer study input";
            return false;
        }
        if (!first)
            applied << "; ";
        applied << "int[" << entry.first << "]=" << entry.second;
        first = false;
    }

    for (const auto& entry : overrides.FloatInputs)
    {
        const int result = sc.SetChartStudyInputFloat(chartNumber, studyId, entry.first, entry.second);
        if (result == 0)
        {
            error = "Failed to apply float study input";
            return false;
        }
        if (!first)
            applied << "; ";
        applied << "float[" << entry.first << "]=" << entry.second;
        first = false;
    }

    for (const auto& entry : overrides.StringInputs)
    {
        const SCString value(entry.second.c_str());
        const int result = sc.SetChartStudyInputString(chartNumber, studyId, entry.first, value);
        if (result == 0)
        {
            error = "Failed to apply string study input";
            return false;
        }
        if (!first)
            applied << "; ";
        applied << "string[" << entry.first << "]=" << entry.second;
        first = false;
    }

    std::ostringstream readback;
    bool firstReadback = true;
    for (const auto& entry : overrides.IntInputs)
    {
        int value = 0;
        if (sc.GetChartStudyInputInt(chartNumber, studyId, entry.first, value) != 0)
        {
            if (!firstReadback)
                readback << "; ";
            readback << "int[" << entry.first << "]=" << value;
            firstReadback = false;
        }
    }
    for (const auto& entry : overrides.FloatInputs)
    {
        double value = 0.0;
        if (sc.GetChartStudyInputFloat(chartNumber, studyId, entry.first, value) != 0)
        {
            if (!firstReadback)
                readback << "; ";
            readback << "float[" << entry.first << "]=" << value;
            firstReadback = false;
        }
    }
    for (const auto& entry : overrides.StringInputs)
    {
        SCString value;
        if (sc.GetChartStudyInputString(chartNumber, studyId, entry.first, value) != 0)
        {
            if (!firstReadback)
                readback << "; ";
            readback << "string[" << entry.first << "]=" << value.GetChars();
            firstReadback = false;
        }
    }

    sc.RecalculateChart(chartNumber);
    if (!firstReadback)
        applied << "; readback_before_recalc: " << readback.str();
    detail = applied.str();
    return true;
}

} // namespace

SCSFExport scsf_OceanTradingReplayController(SCStudyInterfaceRef sc)
{
    SCInputRef CommandFilePath = sc.Input[0];
    SCInputRef StatusFilePath = sc.Input[1];
    SCInputRef EnableController = sc.Input[2];

    if (sc.SetDefaults)
    {
        sc.GraphName = "Ocean Trading Replay Controller v0.1.11";
        sc.StudyDescription = "Replay-only command bridge for Ocean Trading Sierra connector. v0.1.11 resumes paused starts before acknowledging replay-running state.";
        sc.AutoLoop = 0;
        sc.UpdateAlways = 1;
        sc.GraphRegion = 0;
        sc.HideStudy = 1;

        CommandFilePath.Name = "Command File Path";
        CommandFilePath.SetPathAndFileName(DEFAULT_COMMAND_PATH);

        StatusFilePath.Name = "Status File Path";
        StatusFilePath.SetPathAndFileName(DEFAULT_STATUS_PATH);

        EnableController.Name = "Enable Replay Controller";
        EnableController.SetYesNo(1);
        return;
    }

    if (!EnableController.GetYesNo())
        return;

    SCString commandPath = CommandFilePath.GetPathAndFileName();
    SCString statusPath = StatusFilePath.GetPathAndFileName();
    if (commandPath.IsEmpty() || statusPath.IsEmpty())
    {
        const SCString controlDir = DefaultControlDir(sc);
        if (commandPath.IsEmpty())
        {
            commandPath = controlDir;
            commandPath += "\\replay-command.json";
        }
        if (statusPath.IsEmpty())
        {
            statusPath = controlDir;
            statusPath += "\\replay-status.json";
        }
    }

    SCDateTime& activeEndDateTime = sc.GetPersistentSCDateTime(1);
    SCDateTime& activeStartDateTime = sc.GetPersistentSCDateTime(2);
    SCString& activeCommandId = sc.GetPersistentSCString(1);
    SCString& activeRequestedStart = sc.GetPersistentSCString(2);
    SCString& activeRequestedEnd = sc.GetPersistentSCString(3);
    SCString& activeReplaySpeed = sc.GetPersistentSCString(4);
    const int activeChartNumber = sc.GetPersistentInt(2);
    int& activeEndArmed = sc.GetPersistentInt(3);
    int& resumeAfterStartPending = sc.GetPersistentInt(4);
    int& resumeAfterStartAttempts = sc.GetPersistentInt(5);
    int& pendingStartRequested = sc.GetPersistentInt(6);
    int& pendingStartAttempts = sc.GetPersistentInt(7);
    int& pendingClearTradeData = sc.GetPersistentInt(8);
    int& pendingSkipEmptyPeriods = sc.GetPersistentInt(9);
    bool launchedStartThisCall = false;

    if (pendingStartRequested)
    {
        std::string readinessDetail;
        const int chartNumber = activeChartNumber > 0 ? activeChartNumber : sc.ChartNumber;
        if (!ChartDataReadyForReplayStart(sc, chartNumber, readinessDetail))
        {
            WriteStatus(
                sc,
                statusPath,
                activeCommandId.GetChars(),
                "start",
                activeRequestedStart.GetChars(),
                activeRequestedEnd.GetChars(),
                activeReplaySpeed.GetChars(),
                "start_pending_chart_loading",
                "",
                readinessDetail);
        }
        else if (pendingStartAttempts < 12)
        {
            ++pendingStartAttempts;
            int speedMultiplier = std::atoi(activeReplaySpeed.GetChars());
            if (speedMultiplier < 1)
                speedMultiplier = 1;
            n_ACSIL::s_ChartReplayParameters replayParameters;
            replayParameters.ChartNumber = chartNumber;
            replayParameters.ReplaySpeed = static_cast<float>(speedMultiplier);
            replayParameters.StartDateTime = activeStartDateTime;
            replayParameters.SkipEmptyPeriods = pendingSkipEmptyPeriods ? 1 : 0;
            replayParameters.ReplayMode = n_ACSIL::REPLAY_MODE_ACCURATE_TRADING_SYSTEM_BACK_TEST;
            replayParameters.ClearExistingTradeSimulationDataForSymbolAndTradeAccount = pendingClearTradeData ? 1 : 0;
            replayParameters.ChartsToReplay = n_ACSIL::CHARTS_TO_REPLAY_SINGLE_CHART;

            const int startResult = sc.StartChartReplayNew(replayParameters);
            resumeAfterStartPending = 1;
            resumeAfterStartAttempts = 0;
            pendingStartRequested = 0;
            launchedStartThisCall = true;
            WriteStatus(
                sc,
                statusPath,
                activeCommandId.GetChars(),
                "start",
                activeRequestedStart.GetChars(),
                activeRequestedEnd.GetChars(),
                activeReplaySpeed.GetChars(),
                "start_launch_requested",
                "",
                readinessDetail + "; launch_api=StartChartReplayNew; start_result=" + std::to_string(startResult));
        }
        else
        {
            pendingStartRequested = 0;
            pendingStartAttempts = 0;
            WriteStatus(
                sc,
                statusPath,
                activeCommandId.GetChars(),
                "start",
                activeRequestedStart.GetChars(),
                activeRequestedEnd.GetChars(),
                activeReplaySpeed.GetChars(),
                "error",
                "Replay start was not attempted because chart data never became ready.",
                readinessDetail);
        }
    }

    if (resumeAfterStartPending && !launchedStartThisCall)
    {
        const int chartNumber = activeChartNumber > 0 ? activeChartNumber : sc.ChartNumber;
        if (ReplayIsActivelyRunning(sc, chartNumber))
        {
            resumeAfterStartPending = 0;
            resumeAfterStartAttempts = 0;
            WriteStatus(
                sc,
                statusPath,
                activeCommandId.GetChars(),
                "start",
                activeRequestedStart.GetChars(),
                activeRequestedEnd.GetChars(),
                activeReplaySpeed.GetChars(),
                "replay_running",
                "",
                "Replay entered active running state after launch request.");
        }
        else if (resumeAfterStartAttempts < 12)
        {
            ++resumeAfterStartAttempts;
            sc.ResumeChartReplay(chartNumber);
            WriteStatus(
                sc,
                statusPath,
                activeCommandId.GetChars(),
                "start",
                activeRequestedStart.GetChars(),
                activeRequestedEnd.GetChars(),
                activeReplaySpeed.GetChars(),
                "resume_after_start_requested",
                "",
                ReplayIsPaused(sc, chartNumber)
                    ? "Replay launch entered paused state; delayed resume requested before accepting start."
                    : "Replay launch was requested; delayed resume requested while waiting for Sierra to enter active replay state.");
        }
        else
        {
            resumeAfterStartPending = 0;
            resumeAfterStartAttempts = 0;
            WriteStatus(
                sc,
                statusPath,
                activeCommandId.GetChars(),
                "resume_after_start",
                activeRequestedStart.GetChars(),
                activeRequestedEnd.GetChars(),
                activeReplaySpeed.GetChars(),
                "error",
                "Replay did not enter active running state after delayed resume attempts.",
                "");
        }
    }

    if (sc.IsReplayRunning() && activeEndDateTime.GetAsDouble() > 0.0)
    {
        const SCDateTime currentDateTime = ReplayAwareCurrentDateTime(sc);
        if (IsValidReplayDateTime(currentDateTime) && !activeEndArmed && currentDateTime <= activeEndDateTime)
            activeEndArmed = 1;

        const bool CurrentIsBeforeRequestedStart = IsValidReplayDateTime(currentDateTime)
            && activeStartDateTime.GetAsDouble() > 0.0
            && currentDateTime < activeStartDateTime;
        const bool CurrentReachedRequestedEnd = IsValidReplayDateTime(currentDateTime)
            && !CurrentIsBeforeRequestedStart
            && currentDateTime >= activeEndDateTime;

        if (CurrentReachedRequestedEnd)
        {
            sc.StopChartReplay(activeChartNumber > 0 ? activeChartNumber : sc.ChartNumber);
            WriteStatus(
                sc,
                statusPath,
                activeCommandId.GetChars(),
                "auto_stop",
                activeRequestedStart.GetChars(),
                activeRequestedEnd.GetChars(),
                activeReplaySpeed.GetChars(),
                "auto_stop_requested_at_requested_end",
                "",
                "Replay current time reached or passed requestedEndDateTime.");
            activeEndDateTime.Clear();
            activeStartDateTime.Clear();
            activeEndArmed = 0;
        }
    }

    const std::string commandText = ReadTextFile(commandPath);
    if (commandText.empty())
        return;

    const std::string commandId = ExtractJsonString(commandText, "commandId");
    const int lastCommandHash = sc.GetPersistentInt(1);
    int currentCommandHash = 0;
    for (char ch : commandId)
        currentCommandHash = (currentCommandHash * 131) + ch;

    if (commandId.empty() || currentCommandHash == lastCommandHash)
        return;

    sc.SetPersistentInt(1, currentCommandHash);

    const std::string action = ExtractJsonString(commandText, "action");
    const std::string requestedStart = ExtractJsonString(commandText, "startDateTime");
    const std::string requestedEnd = ExtractJsonString(commandText, "endDateTime");
    const std::string replaySpeed = ExtractJsonString(commandText, "replaySpeed");
    const int chartNumber = ExtractJsonInt(commandText, "chartNumber", sc.ChartNumber);
    const int speedMultiplier = ExtractJsonInt(commandText, "replaySpeedMultiplier", 480);
    const bool clearTradeData = ExtractJsonBool(commandText, "clearTradeSimulationData", true);
    const bool skipEmptyPeriods = ExtractJsonBool(commandText, "skipEmptyPeriods", true);

    const StudyInputOverrides overrides = ExtractStudyInputOverrides(commandText);

    std::string error;
    std::string detail;
    std::string status = "accepted";

    if (action == "apply_settings")
    {
        if (ApplyStudyInputOverrides(sc, chartNumber, overrides, detail, error))
            status = "settings_applied";
        else
            status = "error";
    }
    else if (action == "start")
    {
        if (!overrides.StudyName.empty() && !ApplyStudyInputOverrides(sc, chartNumber, overrides, detail, error))
        {
            status = "error";
        }
        else
        {
        SCDateTime startDateTime;
        SCDateTime endDateTime;
        if (!ParseDateTime(requestedStart, startDateTime))
        {
            error = "Invalid or missing startDateTime";
            status = "error";
        }
        else if (!requestedEnd.empty() && !ParseDateTime(requestedEnd, endDateTime))
        {
            error = "Invalid endDateTime";
            status = "error";
        }
        else
        {
            activeStartDateTime = startDateTime;
            if (requestedEnd.empty())
                activeEndDateTime.Clear();
            else
                activeEndDateTime = endDateTime;
            activeEndArmed = 0;
            pendingStartRequested = 1;
            pendingStartAttempts = 0;
            pendingClearTradeData = clearTradeData ? 1 : 0;
            pendingSkipEmptyPeriods = skipEmptyPeriods ? 1 : 0;
            resumeAfterStartPending = 0;
            resumeAfterStartAttempts = 0;
            activeCommandId = commandId.c_str();
            activeRequestedStart = requestedStart.c_str();
            activeRequestedEnd = requestedEnd.c_str();
            activeReplaySpeed = replaySpeed.c_str();
            sc.SetPersistentInt(2, chartNumber);
            status = "start_pending_chart_ready";
            if (!requestedEnd.empty())
            {
                if (!detail.empty())
                    detail += "; ";
                detail += "launch_api=StartChartReplayNew; clear_trade_data_requested=" + std::string(clearTradeData ? "yes" : "no") + "; controller will wait for chart data before launching and auto-stop at requestedEndDateTime=" + requestedEnd;
            }
            else
            {
                if (!detail.empty())
                    detail += "; ";
                detail += "launch_api=StartChartReplayNew; clear_trade_data_requested=" + std::string(clearTradeData ? "yes" : "no") + "; controller will wait for chart data before launching";
            }
        }
        }
    }
    else if (action == "stop")
    {
        sc.StopChartReplay(chartNumber);
        activeEndDateTime.Clear();
        activeStartDateTime.Clear();
        activeEndArmed = 0;
        resumeAfterStartPending = 0;
        resumeAfterStartAttempts = 0;
        pendingStartRequested = 0;
        pendingStartAttempts = 0;
        status = "stop_requested";
    }
    else if (action == "pause")
    {
        sc.PauseChartReplay(chartNumber);
        status = "pause_requested";
    }
    else if (action == "resume")
    {
        sc.ResumeChartReplay(chartNumber);
        status = "resume_requested";
    }
    else if (action == "status")
    {
        status = "status";
    }
    else
    {
        error = "Unsupported action";
        status = "error";
    }

    WriteStatus(sc, statusPath, commandId, action, requestedStart, requestedEnd, replaySpeed, status, error, detail);
}
