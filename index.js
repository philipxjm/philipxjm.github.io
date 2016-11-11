$(window).load(function() {
    setTimeout(function() {
        window.location.reload();
    }, 180000);

    var image = document.getElementById('background');
    image.crossOrigin = 'anonymous';
    image.src = 'http://i.imgur.com/x86Mup0.jpg';


    var theWindow = $(window),
        $background = $("#background"),
        aspectRatio = $background.width() / $background.height();
    console.log("bg height: " + $background.height())
    console.log("bg width: " + $background.width())
    console.log("window height: " + theWindow.height())
    console.log("window width: " + theWindow.width())

    function resizeBg() {

        if ((theWindow.width() / theWindow.height()) < aspectRatio) {
            $background
                .removeClass()
                .addClass('bgheight');
        } else {
            $background
                .removeClass()
                .addClass('bgwidth');
        }

    }

    theWindow.resize(resizeBg).trigger("resize");

    if ((theWindow.width() / theWindow.height()) < aspectRatio) {
        image.onload = function() {
            var engine = new RainyDay({
                image: this
            });
            engine.rain([
                [0, 2, 100],
                [1, 4, 0]
            ], 300);
        };
        console.log("1")
    } else {
        image.onload = function() {
            var engine = new RainyDay({
                image: this
            });
            engine.rain([
                [0, 2, 100],
                [1, 4, 1]
            ], 300);
        };
        console.log("2")
    }

});
